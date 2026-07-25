import {
  FIXED_OPTIONS,
  MAX_RETRIES,
  PROTOCOL_VERSION,
  SCORING_VERSION,
  WORKLOADS,
} from "./protocol.js";
import { CLIENT_VERSION } from "./version.js";
import { deriveMetrics } from "./derivation/metrics.js";
import { validatePass } from "./derivation/validity.js";
import {
  extractLayerAssignment,
  extractKvCacheMetadata,
  extractModelMetadata,
  extractRawMeasurement,
  extractResolvedConfiguration,
} from "./derivation/ollama.js";
import { resolveGpuMemoryBandwidth } from "./derivation/gpu-bandwidth.js";

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

// Presentation-only planning band used to turn the configured token schedule
// into a deliberately broad wall-clock range. It is not a performance target
// and never enters a result record or derivation.
const ESTIMATE_TOKENS_PER_SECOND_RANGE = Object.freeze({
  slow: 50,
  fast: 200,
});

function displayMinutes(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

export function estimateRunDuration(workloads = WORKLOADS) {
  let scheduledPasses = 0;
  let configuredTokens = 0;
  const workloadTokens = {};
  for (const [id, workload] of Object.entries(workloads)) {
    const requests = workload.warmups + workload.repetitions;
    // Planning figure only: the midpoint of the workload's accepted token band.
    // Never a validity input and never recorded — it exists solely to turn the
    // configured schedule into a wall-clock range.
    const bandMidpoint = workload.promptTokenRange
      ? (workload.promptTokenRange.min + workload.promptTokenRange.max) / 2
      : 0;
    const tokensPerRequest = bandMidpoint + workload.numPredict;
    const tokens = requests * tokensPerRequest;
    scheduledPasses += requests;
    configuredTokens += tokens;
    workloadTokens[id] = tokens;
  }
  const fastestSeconds =
    configuredTokens / ESTIMATE_TOKENS_PER_SECOND_RANGE.fast;
  const slowestSeconds =
    configuredTokens / ESTIMATE_TOKENS_PER_SECOND_RANGE.slow;
  return {
    scheduledPasses,
    configuredTokens,
    estimatedMinutes: {
      minimum: displayMinutes(fastestSeconds),
      maximum: displayMinutes(slowestSeconds),
    },
    dominantWorkload: Object.entries(workloadTokens).sort(
      (left, right) => right[1] - left[1],
    )[0]?.[0] ?? null,
  };
}

function durationEstimateMessages() {
  const estimate = estimateRunDuration();
  return [
    `Estimated run time: about ${estimate.estimatedMinutes.minimum}-${estimate.estimatedMinutes.maximum} minutes ` +
      `for ${estimate.scheduledPasses} scheduled workload passes ` +
      "(hardware-dependent; retries can extend it).",
    `W3 dominates the configured work at num_ctx = ${WORKLOADS.w3.numCtx}.`,
  ];
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

async function collectAttempt(adapter, workload) {
  const raw = await adapter.generate(workload.model, workload);
  const measurement = extractRawMeasurement(raw);
  const validity = validatePass(measurement, workload);
  return { raw, measurement, validity };
}

async function measuredPass(
  adapter,
  workload,
  passIndex,
  onProgress,
  captureResponses,
) {
  const attempts = [];
  const capturedAttempts = captureResponses ? [] : null;
  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    progress(
      onProgress,
      `${workload.name}: measured pass ${passIndex}/${workload.repetitions}` +
        (retry > 0 ? `, retry ${retry}/${MAX_RETRIES}` : ""),
    );
    const attempt = await collectAttempt(adapter, workload);
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
) {
  const workload = { ...definition, model };
  progress(onProgress, `${workload.name}: warmup (discarded)`);
  const warmupRaw = await adapter.generate(model, workload);
  captureResponses?.push([warmupRaw]);
  const warmup = extractRawMeasurement(warmupRaw);
  const measuredPasses = [];
  for (let index = 1; index <= workload.repetitions; index += 1) {
    measuredPasses.push(
      await measuredPass(
        adapter,
        workload,
        index,
        onProgress,
        captureResponses,
      ),
    );
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
    const attempt = await collectAttempt(adapter, workload);
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

  for (const id of ["w2", "w3", "w4"]) {
    rawMeasurements.workloads[id] = await runRepeatedWorkload(
      adapter,
      WORKLOADS[id],
      model,
      onProgress,
      captureWorkloads?.[id],
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
    qualityConditions: publicQualityConditions(resolvedPreconditions.issues),
    runtime: {
      name: "ollama",
      version: runtimeDetection.raw.version ?? null,
      endpoint: "loopback",
      layerAssignment: extractLayerAssignment(showRaw, runningEntry),
      kvCacheMetadata: extractKvCacheMetadata(showRaw),
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
      workloads: captureWorkloads,
    });
  }
  return record;
}
