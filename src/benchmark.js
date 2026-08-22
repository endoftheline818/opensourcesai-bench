import {
  buildCallPrompt,
  FIXED_OPTIONS,
  MAX_RETRIES,
  PROBE_CALL_INDEX,
  PROTOCOL_VERSION,
  SCORING_VERSION,
  WORKLOADS,
} from "./protocol.js";
import { CLIENT_VERSION } from "./version.js";
import { deriveMetrics } from "./derivation/metrics.js";
import { checkPromptFit, validatePass } from "./derivation/validity.js";
import {
  extractLayerAssignment,
  extractKvCacheMetadata,
  extractModelMetadata,
  extractOffloadPlacement,
  extractRawMeasurement,
  extractResolvedConfiguration,
} from "./derivation/ollama.js";
import { resolveGpuMemoryBandwidth } from "./derivation/gpu-bandwidth.js";
import { deriveRuntimeEnvironment } from "./derivation/environment.js";

export class QualityRefusalError extends Error {
  constructor(issues) {
    super("Run-quality preconditions were not met");
    this.name = "QualityRefusalError";
    this.issues = issues;
  }
}

function progress(callback, message) {
  callback?.(message);
}

// Presentation-only planning bands used to turn the configured token schedule
// into a deliberately broad wall-clock range. Neither is a performance target
// and neither ever enters a result record or derivation.
//
// Two separate bands, not one, because prefill and generation are different
// throughput regimes -- the same distinction the roofline model already
// treats as load-bearing (see ROOFLINE_LIMITS: "Applies to generation only").
// A single shared band systematically mis-estimates in both directions: on
// real hardware in this project's own validation lab, prefill ran 65-76x
// faster than generation on the very same run (lab run 9, 2026-08-03:
// 177.63 vs 2.34 tok/s), so summing prompt-processing tokens and completion
// tokens under one rate either drowns the fast component in a slow
// assumption (inflating the estimate for an ordinary well-provisioned run to
// several times its real duration) or drowns the slow component in a fast
// one (deflating it for an offload-bound run to a fraction of its real
// duration -- the estimator undershot lab run 9's real ~30-minute run by
// about 4x). Splitting the pools fixes both directions at once.
const GENERATION_TOKENS_PER_SECOND_RANGE = Object.freeze({
  slow: 50,
  fast: 200,
});
// Grounded in every real-hardware prefill figure on record as of 2026-08:
// 177.63-9,353 tok/s across an RTX 3080 and an RTX 4070 Ti, four model
// families, including the severe-offload case above. The floor sits below
// the worst of those on purpose -- prefill is compute-bound and degrades
// under contention too, just less catastrophically than generation -- and
// the ceiling sits below the best of those, staying conservative rather
// than optimizing for the fastest configuration ever measured.
const PREFILL_TOKENS_PER_SECOND_RANGE = Object.freeze({
  slow: 100,
  fast: 5000,
});

function displayMinutes(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

// The two token pools every workload decomposes into: prompt-processing
// tokens (governed by prefill throughput) and completion tokens (governed by
// generation throughput). Shared by the baseline estimate and the live
// reprojection below so both reason about the schedule identically.
function tokenPools(workloads) {
  let scheduledPasses = 0;
  let prefillTokens = 0;
  let generationTokens = 0;
  const workloadSecondsAtSlowBand = {};
  for (const [id, workload] of Object.entries(workloads)) {
    const requests = workload.warmups + workload.repetitions;
    // Planning figure only: the midpoint of the workload's accepted token
    // band. Never a validity input and never recorded.
    const bandMidpoint = workload.promptTokenRange
      ? (workload.promptTokenRange.min + workload.promptTokenRange.max) / 2
      : 0;
    const workloadPrefillTokens = requests * bandMidpoint;
    const workloadGenerationTokens = requests * workload.numPredict;
    scheduledPasses += requests;
    prefillTokens += workloadPrefillTokens;
    generationTokens += workloadGenerationTokens;
    // Pessimistic (slow-band) wall-clock contribution, not raw token count --
    // which workload actually threatens to dominate real duration under
    // adverse conditions is not the same question as which one has the most
    // scheduled tokens, since prefill tokens are processed far faster than
    // generation tokens regardless of hardware.
    workloadSecondsAtSlowBand[id] =
      workloadPrefillTokens / PREFILL_TOKENS_PER_SECOND_RANGE.slow +
      workloadGenerationTokens / GENERATION_TOKENS_PER_SECOND_RANGE.slow;
  }
  return {
    scheduledPasses,
    prefillTokens,
    generationTokens,
    dominantWorkload:
      Object.entries(workloadSecondsAtSlowBand).sort(
        (left, right) => right[1] - left[1],
      )[0]?.[0] ?? null,
  };
}

export function estimateRunDuration(workloads = WORKLOADS) {
  const pools = tokenPools(workloads);
  const fastestSeconds =
    pools.prefillTokens / PREFILL_TOKENS_PER_SECOND_RANGE.fast +
    pools.generationTokens / GENERATION_TOKENS_PER_SECOND_RANGE.fast;
  const slowestSeconds =
    pools.prefillTokens / PREFILL_TOKENS_PER_SECOND_RANGE.slow +
    pools.generationTokens / GENERATION_TOKENS_PER_SECOND_RANGE.slow;
  return {
    scheduledPasses: pools.scheduledPasses,
    configuredPrefillTokens: pools.prefillTokens,
    configuredGenerationTokens: pools.generationTokens,
    estimatedMinutes: {
      minimum: displayMinutes(fastestSeconds),
      maximum: displayMinutes(slowestSeconds),
    },
    dominantWorkload: pools.dominantWorkload,
  };
}

// Recomputes the same two-pool estimate using OBSERVED rates from a real
// measured pass in place of the static bands -- a single point figure, not a
// range, because a real measurement is not a guess. Either rate may be
// unavailable (falls back to that pool's slow-band assumption) but not both,
// since the caller already checked at least one is finite before calling
// this.
function reviseEstimateFromObservedRates(
  { generationTokensPerSecond, prefillTokensPerSecond },
  workloads = WORKLOADS,
) {
  const pools = tokenPools(workloads);
  const generationRate =
    Number.isFinite(generationTokensPerSecond) && generationTokensPerSecond > 0
      ? generationTokensPerSecond
      : GENERATION_TOKENS_PER_SECOND_RANGE.slow;
  const prefillRate =
    Number.isFinite(prefillTokensPerSecond) && prefillTokensPerSecond > 0
      ? prefillTokensPerSecond
      : PREFILL_TOKENS_PER_SECOND_RANGE.slow;
  const totalSeconds =
    pools.prefillTokens / prefillRate + pools.generationTokens / generationRate;
  return displayMinutes(totalSeconds);
}

function minutesPhrase(minutes) {
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function durationEstimateMessages() {
  const estimate = estimateRunDuration();
  const dominant = WORKLOADS[estimate.dominantWorkload];
  const range =
    estimate.estimatedMinutes.minimum === estimate.estimatedMinutes.maximum
      ? minutesPhrase(estimate.estimatedMinutes.minimum)
      : `about ${estimate.estimatedMinutes.minimum}-${estimate.estimatedMinutes.maximum} minutes`;
  const messages = [
    `Estimated run time: ${range} for ${estimate.scheduledPasses} scheduled workload passes ` +
      "(hardware-dependent; retries can extend it).",
  ];
  if (dominant) {
    messages.push(
      `${dominant.id.toUpperCase()} (${dominant.name}) dominates the configured work at num_ctx = ${dominant.numCtx}.`,
    );
  }
  return messages;
}

// Fires at most once per run, after the first real measured pass, and only
// when the observed pace projects a total meaningfully worse than the
// baseline estimate's own upper bound already promised -- so a healthy run
// stays silent and only a genuinely surprising one gets a second number.
// Deliberately a single revised TOTAL, not a "remaining time" calculation:
// avoids needing to track completed-vs-remaining scheduled work precisely,
// and the user can subtract elapsed time themselves exactly as they would
// for the original estimate.
function createEstimateReviser(onProgress) {
  let alreadyRevised = false;
  return function maybeReviseEstimate(measurement) {
    if (alreadyRevised) return;
    const generationRate =
      Number.isFinite(measurement.eval_count) &&
      Number.isFinite(measurement.eval_duration) &&
      measurement.eval_duration > 0
        ? measurement.eval_count / (measurement.eval_duration / 1e9)
        : null;
    const prefillRate =
      Number.isFinite(measurement.prompt_eval_count) &&
      Number.isFinite(measurement.prompt_eval_duration) &&
      measurement.prompt_eval_duration > 0
        ? measurement.prompt_eval_count / (measurement.prompt_eval_duration / 1e9)
        : null;
    if (generationRate === null && prefillRate === null) return;
    const original = estimateRunDuration();
    const revisedMinutes = reviseEstimateFromObservedRates({
      generationTokensPerSecond: generationRate,
      prefillTokensPerSecond: prefillRate,
    });
    if (revisedMinutes <= original.estimatedMinutes.maximum) return;
    alreadyRevised = true;
    progress(
      onProgress,
      `Revised estimate based on your first measured pass: ${minutesPhrase(revisedMinutes)} total ` +
        "(measured pace, not a performance claim).",
    );
  };
}

function sanitizeSystem(system, freeVramBytesAtLoad = null) {
  return {
    cpu: { model: system.cpu.model },
    gpu: {
      present: system.gpu.present,
      model: system.gpu.model,
      totalVramBytes: system.gpu.totalVramBytes,
      freeVramBytesAtCheck: system.gpu.freeVramBytes,
      freeVramBytesAtLoad,
      utilizationPercentAtCheck: system.gpu.utilizationPercent,
      driverVersion: system.gpu.driverVersion,
      provider: system.gpu.provider,
    },
    memory: system.memory,
    os: system.os,
    power: system.power,
  };
}

function publicQualityConditions(issues) {
  return issues.map((issue) => ({
    code: issue.code,
    // Avoid persisting process names or other installed-software details.
    detected: true,
  }));
}

// Applies buildCallPrompt (protocol.js) to build the exact per-call workload
// sent to the adapter. See the comment on WORKLOADS.w3.varyPromptPerCall for
// why this exists — kept as a thin wrapper here so collectAttempt and the
// warmup call share one construction path.
function callWorkload(workload, callIndex) {
  const prompt = buildCallPrompt(workload, callIndex);
  return prompt === workload.prompt ? workload : { ...workload, prompt };
}

function createCallCounter() {
  let next = 0;
  return () => next++;
}

// §4 model-protocol fit, checked before anything is measured.
//
// A model whose tokenizer and chat template put prompt_eval_count outside a
// workload's band fails every measured pass of that workload -- deterministic,
// not flaky, since temperature and seed are protocol constants (§5.1). The
// validity rule catching it is correct and stays exactly as strict; the defect
// was purely that the failure was discoverable only after paying for it. On a
// Raspberry Pi 4B, `tinyllama:latest` burned about 13 minutes to produce a
// report whose generation, prefill and TTFT were all unavailable, and the
// cause was visible nowhere in the human-readable output.
//
// bandMidpoint (see tokenPools) sizes the schedule toward the middle of each
// band, but it is a planning figure and says so; nothing reconciled a real
// tokenizer against a real band before the measurement loop began. This does.
//
// Deliberately NOT covered: the other way a model fails the protocol
// deterministically -- stopping generation before num_predict, as
// phi3:3.8b-mini-128k-instruct-fp16 does at exactly 107 tokens under both a
// 128- and a 512-token budget (§12.1a). A prompt's token count is a property
// of the tokenizer and template, knowable from one cheap prefill. Early EOS is
// a property of generation and the only way to know it is to generate, which
// costs a workload's whole budget. Refusing on a band the run can check for a
// few seconds is not the same trade as refusing on a behaviour it would have
// to spend minutes to observe, so this gate claims only the first and the
// spec says so rather than implying coverage it does not have.
async function checkPromptBands(adapter, model, onProgress) {
  if (typeof adapter.probePrompt !== "function") return [];

  // W2 and W4 send the same prompt at the same num_ctx against the same band,
  // so one probe answers for both. Probing per workload would double the cost
  // to buy a second copy of the same number.
  const probes = new Map();
  for (const workload of Object.values(WORKLOADS)) {
    if (workload.promptTokenRange === null) continue;
    const probeWorkload = callWorkload({ ...workload, model }, PROBE_CALL_INDEX);
    const key = `${probeWorkload.prompt} ${workload.numCtx}`;
    const existing = probes.get(key);
    if (existing) {
      existing.workloadIds.push(workload.id);
      continue;
    }
    probes.set(key, { workload: probeWorkload, workloadIds: [workload.id] });
  }

  const issues = [];
  for (const { workload, workloadIds } of probes.values()) {
    const label = workloadIds.map((id) => id.toUpperCase()).join("/");
    progress(onProgress, `Checking ${label} prompt fit for ${model}`);
    const measurement = extractRawMeasurement(
      await adapter.probePrompt(model, workload),
    );
    const promptTokens = measurement?.prompt_eval_count;
    // An inconclusive probe is not evidence of a bad model. A runtime that
    // reports no prompt token count cannot convict one, so the run proceeds
    // and §5.4 stays the backstop it always was.
    if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens)) {
      continue;
    }
    for (const reason of checkPromptFit(promptTokens, workload)) {
      issues.push({
        code: `${reason.code}-precondition`,
        workloads: [...workloadIds],
        actual: reason.actual ?? promptTokens,
        // The operator can change the model; they cannot change what this
        // model's tokenizer does with a fixed prompt. Neither existing
        // guidance branch fits, so the issue says which one it needs.
        resolution: "select-a-different-model",
        message:
          `${model} produces ${promptTokens} prompt tokens for ` +
          `${label} — ${reason.message}. Every measured ${label} pass would ` +
          "fail validity, and its throughput would be reported as unavailable",
      });
    }
  }
  return issues;
}

async function collectAttempt(adapter, workload, callIndex) {
  const raw = await adapter.generate(
    workload.model,
    callWorkload(workload, callIndex),
  );
  const measurement = extractRawMeasurement(raw);
  // Validated against the ORIGINAL workload, not the per-call variant: the
  // configured promptTokenRange and numCtx are unaffected by the marker,
  // which adds only a handful of tokens against several hundred of headroom.
  const validity = validatePass(measurement, workload);
  return { raw, measurement, validity };
}

async function measuredPass(
  adapter,
  workload,
  passIndex,
  onProgress,
  captureResponses,
  nextCallIndex,
) {
  const attempts = [];
  const capturedAttempts = captureResponses ? [] : null;
  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    progress(
      onProgress,
      `${workload.name}: measured pass ${passIndex}/${workload.repetitions}` +
        (retry > 0 ? `, retry ${retry}/${MAX_RETRIES}` : ""),
    );
    const attempt = await collectAttempt(adapter, workload, nextCallIndex());
    capturedAttempts?.push(attempt.raw);
    attempts.push({
      measurement: attempt.measurement,
      validity: attempt.validity,
    });
    if (attempt.validity.valid) {
      captureResponses?.push(capturedAttempts);
      return {
        index: passIndex,
        valid: true,
        attempts,
        measurement: attempt.measurement,
        validity: attempt.validity,
      };
    }
  }
  const finalAttempt = attempts.at(-1);
  // Raw attempts are retained only in the opt-in capture side channel. They
  // never enter the normal result record.
  captureResponses?.push(capturedAttempts);
  return {
    index: passIndex,
    valid: false,
    attempts,
    measurement: finalAttempt.measurement,
    validity: finalAttempt.validity,
  };
}

async function runRepeatedWorkload(
  adapter,
  definition,
  model,
  onProgress,
  captureResponses,
  onFirstMeasuredPass,
) {
  const workload = { ...definition, model };
  const nextCallIndex = createCallCounter();
  progress(onProgress, `${workload.name}: warmup (discarded)`);
  const warmupRaw = await adapter.generate(
    model,
    callWorkload(workload, nextCallIndex()),
  );
  captureResponses?.push([warmupRaw]);
  const warmup = extractRawMeasurement(warmupRaw);
  const measuredPasses = [];
  for (let index = 1; index <= workload.repetitions; index += 1) {
    const pass = await measuredPass(
      adapter,
      workload,
      index,
      onProgress,
      captureResponses,
      nextCallIndex,
    );
    measuredPasses.push(pass);
    // The measurement's wall-clock timing is usable for a duration estimate
    // regardless of §4 validity -- a pass that gets retried for a slightly
    // off prompt token count still took the time it took.
    if (index === 1) onFirstMeasuredPass?.(pass.measurement);
  }
  return {
    warmup,
    measuredPasses,
    failed: measuredPasses.some((pass) => !pass.valid),
  };
}

async function runColdLoad(
  adapter,
  definition,
  model,
  onProgress,
  captureResponses,
) {
  const workload = { ...definition, model };
  const attempts = [];
  const capturedAttempts = captureResponses ? [] : null;
  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    progress(onProgress, "Cold load: force-unloading target model");
    await adapter.forceUnload(model);
    progress(
      onProgress,
      "Cold load: measured pass 1/1" +
        (retry > 0 ? `, retry ${retry}/${MAX_RETRIES}` : ""),
    );
    // W1 never sets varyPromptPerCall, so callWorkload leaves it inert
    // regardless of the index passed — 0 is arbitrary and unused.
    const attempt = await collectAttempt(adapter, workload, 0);
    capturedAttempts?.push(attempt.raw);
    attempts.push({
      measurement: attempt.measurement,
      validity: attempt.validity,
    });
    if (attempt.validity.valid) break;
  }
  captureResponses?.push(capturedAttempts);
  const finalAttempt = attempts.at(-1);
  const pass = {
    index: 1,
    valid: finalAttempt.validity.valid,
    attempts,
    measurement: finalAttempt.measurement,
    validity: finalAttempt.validity,
  };
  return { warmup: null, measuredPasses: [pass], failed: !pass.valid };
}

export async function runBenchmark({
  adapter,
  model,
  memoryBandwidthGBps = null,
  qualityOverride = false,
  onProgress,
  onFixtureCapture,
  modelIndependentPreconditions = null,
}) {
  progress(onProgress, "Checking run-quality preconditions");
  let resolvedPreconditions;
  if (modelIndependentPreconditions === null) {
    resolvedPreconditions = await adapter.checkPreconditions(model);
  } else {
    const dependent = await adapter.checkModelDependentPreconditions(model);
    resolvedPreconditions = {
      issues: [
        ...modelIndependentPreconditions.issues,
        ...dependent.issues,
      ],
      system: modelIndependentPreconditions.system,
      rawRunningModels: dependent.rawRunningModels,
    };
  }
  if (resolvedPreconditions.issues.length > 0 && !qualityOverride) {
    throw new QualityRefusalError(resolvedPreconditions.issues);
  }
  // Ordered after the machine-state gate on purpose: the probe loads the
  // model, and loading a model onto a contended, battery-limited or
  // out-of-scope machine is precisely what that gate exists to prevent. It is
  // ordered before W1 for the same reason W1 can tolerate it — W1 forces an
  // unload before every attempt, so its cold-load timing is unaffected by a
  // model the probe left resident.
  const promptBandIssues = await checkPromptBands(adapter, model, onProgress);
  if (promptBandIssues.length > 0 && !qualityOverride) {
    // Unload before refusing. Probing loads the model and its keep_alive holds
    // it resident for five minutes, so a refusal would otherwise leave the
    // rejected model in place and the operator's obvious next move -- run
    // again with a different model -- would hit "Ollama already has non-target
    // model X loaded". Found on the rig, not in a test: a refused
    // qwen2.5:7b-instruct-q8_0 blocked the llama3.1:8b run that followed it.
    //
    // A run that proceeds needs no equivalent, because W1 force-unloads before
    // every attempt by design. And a failure to unload must not mask the
    // refusal: the refusal is the answer, the unload is only courtesy.
    try {
      await adapter.forceUnload(model);
    } catch {
      // Intentionally ignored.
    }
    throw new QualityRefusalError(promptBandIssues);
  }
  const bandwidth = resolveGpuMemoryBandwidth({
    manualGBps: memoryBandwidthGBps,
    model: resolvedPreconditions.system.gpu.model,
    totalVramBytes: resolvedPreconditions.system.gpu.totalVramBytes,
  });

  const tagsRaw = await adapter.listModels();
  const tagsEntry = tagsRaw.models?.find(
    (entry) => (entry.name ?? entry.model) === model,
  );
  if (!tagsEntry) {
    throw new Error(`Selected model ${model} is no longer installed`);
  }

  const [runtimeDetection, showRaw] = await Promise.all([
    adapter.detect(),
    adapter.showModel(model),
  ]);

  const rawMeasurements = { workloads: {} };
  const captureWorkloads =
    typeof onFixtureCapture === "function"
      ? { w1: [], w2: [], w3: [], w4: [] }
      : null;
  for (const message of durationEstimateMessages()) {
    progress(onProgress, message);
  }
  rawMeasurements.workloads.w1 = await runColdLoad(
    adapter,
    WORKLOADS.w1,
    model,
    onProgress,
    captureWorkloads?.w1,
  );
  const atLoad = await adapter.collectSystemSnapshot();

  const reviseEstimate = createEstimateReviser(onProgress);
  for (const id of ["w2", "w3", "w4"]) {
    rawMeasurements.workloads[id] = await runRepeatedWorkload(
      adapter,
      WORKLOADS[id],
      model,
      onProgress,
      captureWorkloads?.[id],
      reviseEstimate,
    );
  }

  const runningAfterRaw = await adapter.listRunningModels();
  const runningEntry = runningAfterRaw.models?.find(
    (entry) => (entry.name ?? entry.model) === model,
  );
  const resolved = extractResolvedConfiguration(showRaw, WORKLOADS);
  const record = {
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
    scoringVersion: SCORING_VERSION,
    createdAt: new Date().toISOString(),
    qualityOverride,
    cohortEligible: !qualityOverride,
    qualityConditions: publicQualityConditions([
      ...resolvedPreconditions.issues,
      ...promptBandIssues,
    ]),
    runtime: {
      name: "ollama",
      version: runtimeDetection.raw.version ?? null,
      endpoint: "loopback",
      layerAssignment: extractLayerAssignment(showRaw, runningEntry),
      offloadPlacement: extractOffloadPlacement(runningEntry),
      kvCacheMetadata: extractKvCacheMetadata(showRaw),
      // Run conditions only -- never an input to any derived metric (§8).
      environment: deriveRuntimeEnvironment(
        typeof adapter.readEnvironment === "function"
          ? adapter.readEnvironment()
          : {},
      ),
    },
    model: extractModelMetadata(tagsEntry, showRaw),
    system: sanitizeSystem(
      resolvedPreconditions.system,
      atLoad.gpu.freeVramBytes ?? null,
    ),
    configuration: {
      memoryBandwidthGBps: bandwidth.memoryBandwidthGBps,
      memoryBandwidthSource: bandwidth.source,
      memoryBandwidthTableVersion: bandwidth.tableVersion,
      memoryBandwidthEntryId: bandwidth.entryId,
      fixedOptions: { ...FIXED_OPTIONS, stream: true },
      workloads: Object.fromEntries(
        Object.entries(WORKLOADS).map(([id, workload]) => [
          id,
          {
            numPredict: workload.numPredict,
            numCtx: workload.numCtx,
            keepAlive: workload.keepAlive,
            promptTokenRange: workload.promptTokenRange,
            warmups: workload.warmups,
            repetitions: workload.repetitions,
            varyPromptPerCall: workload.varyPromptPerCall ?? false,
          },
        ]),
      ),
      resolved,
    },
    rawMeasurements,
    derived: null,
  };
  record.derived = deriveMetrics(record);
  if (captureWorkloads) {
    await onFixtureCapture({
      model,
      tagsResponse: tagsRaw,
      showResponse: showRaw,
      // The same /api/ps entry extractOffloadPlacement reads, so a captured
      // fixture can replay the §7.2 placement diagnostics rather than leaving
      // §11's "and fires the diagnostic" criterion checkable only by hand.
      psResponse: runningEntry,
      workloads: captureWorkloads,
    });
  }
  return record;
}
