import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateRunDuration,
  QualityRefusalError,
  runBenchmark,
} from "../src/benchmark.js";
import { WORKLOADS } from "../src/protocol.js";
import { CLIENT_VERSION } from "../src/version.js";

function systemSnapshot() {
  return {
    cpu: { model: "Synthetic CPU" },
    gpu: {
      present: true,
      model: "Synthetic GPU",
      totalVramBytes: 12 * 1024 ** 3,
      freeVramBytes: 8 * 1024 ** 3,
      utilizationPercent: 0,
      driverVersion: "1.2.3",
      provider: "synthetic",
    },
    gpuCount: 1,
    gpuProcesses: [],
    memory: { totalBytes: 32 * 1024 ** 3 },
    os: { platform: "linux", version: "Synthetic", architecture: "x64" },
    power: { present: false, onBattery: false },
  };
}

function bandMidpoint(workload) {
  return workload.promptTokenRange
    ? Math.floor(
        (workload.promptTokenRange.min + workload.promptTokenRange.max) / 2,
      )
    : 5;
}

class FakeAdapter {
  constructor({
    issues = [],
    retryW2 = false,
    retryW1 = false,
    failW4 = false,
    failW1 = false,
    // Per-workload prompt token counts the §4 probe reports. The default is
    // the band midpoint — a model the fixed prompts fit.
    probePromptTokens = {},
  } = {}) {
    this.issues = issues;
    this.retryW2 = retryW2;
    this.retryW1 = retryW1;
    this.failW4 = failW4;
    this.failW1 = failW1;
    this.probePromptTokens = probePromptTokens;
    this.calls = { w1: 0, w2: 0, w3: 0, w4: 0, forceUnload: 0, probe: 0 };
    this.probedWorkloads = [];
    this.probedPrompts = [];
  }

  async probePrompt(_model, workload) {
    this.calls.probe += 1;
    this.probedWorkloads.push(workload.id);
    this.probedPrompts.push(workload.prompt);
    return {
      chunks: [
        {
          done: true,
          total_duration: 1_000_000_000,
          load_duration: 1_000_000_000,
          // hasOwn, not ??, so a test can say "this probe reports no usable
          // count" with null and have that mean null rather than the default.
          prompt_eval_count: Object.hasOwn(this.probePromptTokens, workload.id)
            ? this.probePromptTokens[workload.id]
            : bandMidpoint(workload),
          prompt_eval_duration: 1_000_000_000,
          eval_count: 1,
          eval_duration: 1_000_000,
        },
      ],
      timeToFirstTokenMs: 10,
    };
  }

  async checkPreconditions() {
    return { issues: this.issues, system: systemSnapshot(), rawRunningModels: { models: [] } };
  }

  async listModels() {
    return {
      models: [
        {
          name: "fixture:8b",
          size: 5_000_000_000,
          digest: "sha256:fixture",
          details: {
            family: "fixture",
            parameter_size: "8B",
            quantization_level: "Q4_K_M",
          },
        },
      ],
    };
  }

  async detect() {
    return { available: true, raw: { version: "0.30.10" } };
  }

  async showModel() {
    return {
      details: {
        family: "fixture",
        parameter_size: "8B",
        quantization_level: "Q4_K_M",
      },
      parameters: "synthetic",
      layer_assignment: {
        total_layers: 33,
        gpu_layers: 26,
        cpu_layers: 7,
      },
      model_info: {
        "general.architecture": "fixture",
        "fixture.block_count": 32,
        "fixture.attention.head_count": 32,
        "fixture.attention.head_count_kv": 8,
        "fixture.embedding_length": 4096,
      },
    };
  }

  async forceUnload() {
    this.calls.forceUnload += 1;
    return { chunks: [{ done: true }], timeToFirstTokenMs: null };
  }

  async collectSystemSnapshot() {
    return systemSnapshot();
  }

  async listRunningModels() {
    return {
      models: [
        {
          name: "fixture:8b",
          layer_assignment: {
            total_layers: 33,
            gpu_layers: 26,
            cpu_layers: 7,
          },
        },
      ],
    };
  }

  async generate(_model, workload) {
    this.calls[workload.id] += 1;
    (this.seenPrompts ??= { w1: [], w2: [], w3: [], w4: [] })[
      workload.id
    ].push(workload.prompt);
    let evalCount = workload.numPredict;
    if (this.retryW2 && workload.id === "w2" && this.calls.w2 === 2) {
      evalCount -= 1;
    }
    if (this.failW4 && workload.id === "w4" && this.calls.w4 > 1) {
      evalCount -= 1;
    }
    const promptCount =
      workload.promptTokenRange
        ? Math.floor(
            (workload.promptTokenRange.min + workload.promptTokenRange.max) / 2,
          )
        : 5;
    const evalDuration =
      workload.id === "w4" ? 8_000_000_000 : 1_000_000_000;
    return {
      chunks: [
        {
          response: "not persisted",
          done: true,
          total_duration: 10_000_000_000,
          load_duration:
            workload.id === "w1" &&
            (this.failW1 || (this.retryW1 && this.calls.w1 === 1))
              ? 0
              : 1_000_000_000,
          prompt_eval_count: promptCount,
          prompt_eval_duration: 1_000_000_000,
          eval_count: evalCount,
          eval_duration: evalDuration,
        },
      ],
      timeToFirstTokenMs: 200,
    };
  }
}

test("full run executes one cold pass and warmup plus five measured passes", async () => {
  const adapter = new FakeAdapter();
  const record = await runBenchmark({
    adapter,
    model: "fixture:8b",
    memoryBandwidthGBps: 500,
  });
  assert.deepEqual(adapter.calls, {
    w1: 1,
    w2: 6,
    w3: 6,
    w4: 6,
    forceUnload: 1,
    // Two §4 prompt-fit probes, not three: W2 and W4 send the same prompt at
    // the same num_ctx against the same band, so one probe answers for both.
    // The measured pass counts are unchanged — the probe adds work before the
    // protocol, it does not alter the protocol.
    probe: 2,
  });
  assert.equal(record.rawMeasurements.workloads.w2.measuredPasses.length, 5);
  assert.equal(record.rawMeasurements.workloads.w2.warmup.eval_count, 128);
  assert.equal(record.derived.passFailureRate.percent, 0);
  assert.equal(record.derived.attemptFailureRate.percent, 0);
  assert.equal(record.protocolVersion, "osai-bench/1.3");
  assert.equal(record.clientVersion, CLIENT_VERSION);
  assert.equal(record.scoringVersion, "osai-bench-derive/1.5");
  assert.equal(JSON.stringify(record).includes("not persisted"), false);
});

// Regression coverage for the first real-hardware finding: sending W3's
// identical prompt on every warmup + measured pass let Ollama's runner reuse
// the previous call's KV state for the shared prefix. prompt_eval_count still
// reported ~2,650 but prompt_eval_duration collapsed to ~13ms on every one of
// the five measured passes, producing a reported prefill throughput of
// ~208,000 tok/s — a cache lookup, not a measurement. See the comment on
// WORKLOADS.w3.varyPromptPerCall in protocol.js for the full account.
test("W3's prompt is unique on every call, including retries, to defeat prefix-cache reuse", async () => {
  const adapter = new FakeAdapter({ retryW2: true });
  await runBenchmark({ adapter, model: "fixture:8b" });
  const seen = adapter.seenPrompts.w3;
  // warmup + 5 measured passes, no W3 retries configured in this scenario.
  assert.equal(seen.length, 6);
  assert.equal(
    new Set(seen).size,
    seen.length,
    "every W3 call must send a distinct prompt, or the runtime can reuse the previous call's KV state for the shared prefix",
  );
  for (const prompt of seen) {
    assert.ok(
      prompt.endsWith(WORKLOADS.w3.prompt),
      "the base prompt content must be preserved verbatim; only a prefix marker may vary",
    );
    assert.notEqual(
      prompt,
      WORKLOADS.w3.prompt,
      "every W3 call must differ from the bare configured prompt",
    );
  }
});

test("only W3 varies its prompt; W1, W2, and W4 send the exact configured prompt on every call", async () => {
  const adapter = new FakeAdapter({ retryW2: true, retryW1: true });
  await runBenchmark({ adapter, model: "fixture:8b" });
  for (const id of ["w1", "w2", "w4"]) {
    const seen = adapter.seenPrompts[id];
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((prompt) => prompt === WORKLOADS[id].prompt),
      `${id} must send the exact configured prompt on every call, including retries — ` +
        "it is not affected by the W3 caching defect and must not be changed incidentally",
    );
  }
});

test("fixture capture side channel preserves ordered attempts per scheduled slot", async () => {
  const adapter = new FakeAdapter({ retryW2: true });
  let captured = null;
  const record = await runBenchmark({
    adapter,
    model: "fixture:8b",
    onFixtureCapture: (value) => {
      captured = value;
    },
  });
  assert.equal(record.rawMeasurements.workloads.w2.measuredPasses[0].attempts.length, 2);
  assert.equal(captured.model, "fixture:8b");
  assert.equal(captured.tagsResponse.models.length, 1);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(captured.workloads).map(([id, slots]) => [
        id,
        slots.length,
      ]),
    ),
    { w1: 1, w2: 6, w3: 6, w4: 6 },
  );
  assert.equal(captured.workloads.w2[1].length, 2);
  assert.equal(captured.workloads.w2[1][0].chunks[0].eval_count, 127);
  assert.equal(captured.workloads.w2[1][1].chunks[0].eval_count, 128);
  assert.equal(
    captured.workloads.w2[1][0].chunks[0].response,
    "not persisted",
  );
});

test("duration estimate follows the configured schedule, splitting prefill and generation token pools", () => {
  // 18,789 prefill tokens + 3,847 generation tokens = 22,636 total -- the
  // same combined figure the single-pool estimator used to report, now
  // decomposed rather than summed under one shared rate.
  assert.deepEqual(estimateRunDuration(), {
    scheduledPasses: 19,
    configuredPrefillTokens: 18_789,
    configuredGenerationTokens: 3_847,
    estimatedMinutes: { minimum: 1, maximum: 4 },
    dominantWorkload: "w3",
  });
});

test("duration estimate is printed before the first workload", async () => {
  const messages = [];
  await runBenchmark({
    adapter: new FakeAdapter(),
    model: "fixture:8b",
    onProgress: (message) => messages.push(message),
  });
  const estimateIndex = messages.findIndex((message) =>
    message.startsWith("Estimated run time:"),
  );
  const firstWorkloadIndex = messages.findIndex((message) =>
    message.startsWith("Cold load:"),
  );
  assert.ok(estimateIndex >= 0);
  assert.ok(firstWorkloadIndex > estimateIndex);
  assert.match(messages[estimateIndex + 1], /W3.*dominates.*num_ctx = 4096/i);
});

// A minimal adapter, independent of FakeAdapter, so its generate() can
// report exact per-workload durations without inheriting FakeAdapter's own
// retry/capture bookkeeping. FakeAdapter's default timings are themselves
// unrealistic for prefill (a flat 1 second for a ~42-token prompt is ~42
// tok/s, below even this module's pessimistic 100 tok/s floor) -- fine for
// every OTHER test, which never inspects onProgress for a revision message,
// but wrong for these two, which need to distinguish "genuinely healthy"
// from "genuinely offloaded" on purpose.
function ratedAdapter({ generationTokensPerSecond, prefillTokensPerSecond }) {
  const calls = { w1: 0, w2: 0, w3: 0, w4: 0, forceUnload: 0 };
  return {
    calls,
    async checkPreconditions() {
      return { issues: [], system: systemSnapshot(), rawRunningModels: { models: [] } };
    },
    async listModels() {
      return {
        models: [
          {
            name: "fixture:8b",
            size: 5_000_000_000,
            digest: "sha256:fixture",
            details: { family: "fixture", parameter_size: "8B", quantization_level: "Q4_K_M" },
          },
        ],
      };
    },
    async detect() {
      return { available: true, raw: { version: "0.30.10" } };
    },
    async showModel() {
      return { details: { family: "fixture", parameter_size: "8B", quantization_level: "Q4_K_M" } };
    },
    async forceUnload() {
      calls.forceUnload += 1;
      return { chunks: [{ done: true }], timeToFirstTokenMs: null };
    },
    async collectSystemSnapshot() {
      return systemSnapshot();
    },
    async listRunningModels() {
      return { models: [] };
    },
    async generate(_model, workload) {
      calls[workload.id] += 1;
      const promptCount = workload.promptTokenRange
        ? Math.floor((workload.promptTokenRange.min + workload.promptTokenRange.max) / 2)
        : 5;
      const evalCount = workload.numPredict;
      return {
        chunks: [
          {
            response: "ok",
            done: true,
            total_duration: 1,
            load_duration: 1_000_000_000,
            prompt_eval_count: promptCount,
            prompt_eval_duration: Math.round(
              (promptCount / prefillTokensPerSecond) * 1e9,
            ),
            eval_count: evalCount,
            eval_duration: Math.round(
              (evalCount / generationTokensPerSecond) * 1e9,
            ),
          },
        ],
        timeToFirstTokenMs: 200,
      };
    },
  };
}

test("a revised estimate is printed once real throughput turns out far worse than the baseline promised", async () => {
  // Rates modeled directly on lab run 9 (2026-08-03, gemma4:31b, severe
  // CPU/GPU split-mode offload): 2.34 tok/s generation, 177.63 tok/s prefill.
  const adapter = ratedAdapter({
    generationTokensPerSecond: 2.34,
    prefillTokensPerSecond: 177.63,
  });
  const messages = [];
  await runBenchmark({
    adapter,
    model: "fixture:8b",
    onProgress: (message) => messages.push(message),
  });
  const revisions = messages.filter((message) =>
    message.startsWith("Revised estimate based on your first measured pass:"),
  );
  assert.equal(
    revisions.length,
    1,
    "must fire exactly once, not once per remaining workload",
  );
  assert.match(revisions[0], /measured pace, not a performance claim/);
  // It fires after W2's first measured pass specifically, not before.
  const revisionIndex = messages.indexOf(revisions[0]);
  const w2FirstPassIndex = messages.findIndex((message) =>
    message.startsWith("Short-prompt latency: measured pass 1/"),
  );
  assert.ok(w2FirstPassIndex >= 0);
  assert.ok(revisionIndex > w2FirstPassIndex);
});

test("no revised estimate is printed when the first measured pass is unremarkable", async () => {
  // Rates modeled on a clean rig run (lab run 6, 2026-08-01, qwen3:8b):
  // 114.73 tok/s generation, 4,388 tok/s prefill -- comfortably inside both
  // planning bands, so the baseline estimate should already cover it.
  const adapter = ratedAdapter({
    generationTokensPerSecond: 114.73,
    prefillTokensPerSecond: 4388,
  });
  const messages = [];
  await runBenchmark({
    adapter,
    model: "fixture:8b",
    onProgress: (message) => messages.push(message),
  });
  assert.equal(
    messages.some((message) => message.startsWith("Revised estimate")),
    false,
  );
});

test("invalid measured pass retries and retains every attempt", async () => {
  const adapter = new FakeAdapter({ retryW2: true });
  const record = await runBenchmark({ adapter, model: "fixture:8b" });
  assert.equal(adapter.calls.w2, 7);
  const first = record.rawMeasurements.workloads.w2.measuredPasses[0];
  assert.equal(first.valid, true);
  assert.equal(first.attempts.length, 2);
  assert.equal(first.attempts[0].validity.valid, false);
  assert.equal(first.attempts[1].validity.valid, true);
  assert.deepEqual(record.derived.passFailureRate, {
    failedMeasuredPasses: 0,
    totalMeasuredPasses: 16,
    percent: 0,
  });
  assert.deepEqual(record.derived.attemptFailureRate, {
    failedAttempts: 1,
    totalAttempts: 17,
    percent: (1 / 17) * 100,
  });
});

test("collector GPU identity resolves bundled bandwidth when no manual override is supplied", async () => {
  const adapter = new FakeAdapter();
  adapter.checkPreconditions = async () => {
    const system = systemSnapshot();
    system.gpu.model = "NVIDIA GeForce RTX 4070 Ti";
    system.gpu.totalVramBytes = 12288 * 1024 ** 2;
    return { issues: [], system, rawRunningModels: { models: [] } };
  };
  const record = await runBenchmark({ adapter, model: "fixture:8b" });
  assert.equal(record.configuration.memoryBandwidthGBps, 504);
  assert.equal(record.configuration.memoryBandwidthSource, "manufacturer-table");
  assert.equal(
    record.configuration.memoryBandwidthEntryId,
    "nvidia-geforce-rtx-4070-ti-12gb",
  );
});

test("pass that remains invalid after two retries fails the workload", async () => {
  const adapter = new FakeAdapter({ failW4: true });
  const record = await runBenchmark({ adapter, model: "fixture:8b" });
  assert.equal(adapter.calls.w4, 16);
  assert.equal(record.rawMeasurements.workloads.w4.failed, true);
  assert.equal(
    record.rawMeasurements.workloads.w4.measuredPasses[0].attempts.length,
    3,
  );
  assert.equal(record.derived.generationTokensPerSecond.median, null);
  assert.deepEqual(record.derived.passFailureRate, {
    failedMeasuredPasses: 5,
    totalMeasuredPasses: 16,
    percent: 31.25,
  });
  assert.deepEqual(record.derived.attemptFailureRate, {
    failedAttempts: 15,
    totalAttempts: 26,
    percent: (15 / 26) * 100,
  });
});

test("invalid W1 retries with a fresh forced unload and can recover", async () => {
  const adapter = new FakeAdapter({ retryW1: true });
  const record = await runBenchmark({ adapter, model: "fixture:8b" });
  assert.equal(adapter.calls.w1, 2);
  assert.equal(adapter.calls.forceUnload, 2);
  assert.equal(record.rawMeasurements.workloads.w1.failed, false);
  assert.equal(record.rawMeasurements.workloads.w1.measuredPasses[0].attempts.length, 2);
});

test("W1 fails only after two retries and three forced unloads", async () => {
  const adapter = new FakeAdapter({ failW1: true });
  const record = await runBenchmark({ adapter, model: "fixture:8b" });
  assert.equal(adapter.calls.w1, 3);
  assert.equal(adapter.calls.forceUnload, 3);
  assert.equal(record.rawMeasurements.workloads.w1.failed, true);
  assert.equal(record.rawMeasurements.workloads.w1.measuredPasses[0].attempts.length, 3);
});

test("quality conditions refuse by default", async () => {
  const adapter = new FakeAdapter({
    issues: [{ code: "on-battery", message: "System is running on battery power" }],
  });
  await assert.rejects(
    () => runBenchmark({ adapter, model: "fixture:8b" }),
    (error) =>
      error instanceof QualityRefusalError &&
      error.issues[0].code === "on-battery",
  );
  assert.equal(adapter.calls.w1, 0);
});

test("resident-model check stays late when startup checks were supplied", async () => {
  const adapter = new FakeAdapter();
  adapter.checkModelDependentPreconditions = async () => ({
    issues: [
      {
        code: "different-model-loaded",
        message: "Ollama already has non-target model other:14b loaded",
      },
    ],
    rawRunningModels: { models: [{ name: "other:14b" }] },
  });
  await assert.rejects(
    () =>
      runBenchmark({
        adapter,
        model: "fixture:8b",
        modelIndependentPreconditions: {
          issues: [],
          system: systemSnapshot(),
        },
      }),
    (error) =>
      error instanceof QualityRefusalError &&
      error.issues[0].code === "different-model-loaded",
  );
  assert.equal(adapter.calls.w1, 0);
});

test("explicit quality override is permanent and cohort-ineligible", async () => {
  const adapter = new FakeAdapter({
    issues: [{ code: "gpu-utilization", message: "GPU utilization above 10%" }],
  });
  const record = await runBenchmark({
    adapter,
    model: "fixture:8b",
    qualityOverride: true,
  });
  assert.equal(record.qualityOverride, true);
  assert.equal(record.cohortEligible, false);
  assert.deepEqual(record.qualityConditions, [
    { code: "gpu-utilization", detected: true },
  ]);
});

// §4 prompt-fit gate (#25). The numbers below are the real measured ones from
// §12.1a, not invented: 68 is qwen2.5:7b-instruct-q8_0 against the W2/W4
// ceiling of 64, and 76/1026 is tinyllama:latest against 20-64 and 2000-4095.

test("#25: a model whose prompt misses the band is refused before anything is measured", async () => {
  const adapter = new FakeAdapter({ probePromptTokens: { w2: 68, w4: 68 } });
  await assert.rejects(
    () => runBenchmark({ adapter, model: "fixture:8b", memoryBandwidthGBps: 500 }),
    (error) => {
      assert.ok(error instanceof QualityRefusalError);
      assert.equal(error.issues.length, 1);
      assert.equal(
        error.issues[0].code,
        "prompt-count-out-of-range-precondition",
      );
      assert.deepEqual(error.issues[0].workloads, ["w2", "w4"]);
      assert.equal(error.issues[0].actual, 68);
      assert.match(error.issues[0].message, /68 prompt tokens for W2\/W4/);
      assert.match(error.issues[0].message, /between 20 and 64 tokens/);
      assert.match(error.issues[0].message, /unavailable/);
      return true;
    },
  );
  // The entire point. Before this gate the same model ran all 19 scheduled
  // passes -- about 13 minutes on a Raspberry Pi 4B -- to produce a report
  // whose generation, prefill and TTFT were all unavailable.
  assert.deepEqual(
    { w1: adapter.calls.w1, w2: adapter.calls.w2, w3: adapter.calls.w3, w4: adapter.calls.w4 },
    { w1: 0, w2: 0, w3: 0, w4: 0 },
    "no measured pass may run once the model is known not to fit",
  );
  assert.equal(adapter.calls.forceUnload, 0);
});

test("#25: both directions are caught, and each names the workload it belongs to", async () => {
  // tinyllama fails in both directions at once: over the short-prompt ceiling
  // and under the long-prompt floor, the latter because its real trained
  // context is 2048 and the W3 floor is 2000.
  const adapter = new FakeAdapter({
    probePromptTokens: { w2: 76, w4: 76, w3: 1026 },
  });
  await assert.rejects(
    () => runBenchmark({ adapter, model: "tinyllama:latest" }),
    (error) => {
      const codes = error.issues.map((issue) => issue.code);
      assert.deepEqual(codes, [
        "prompt-count-out-of-range-precondition",
        "prompt-count-out-of-range-precondition",
      ]);
      const byWorkload = Object.fromEntries(
        error.issues.map((issue) => [issue.workloads.join("/"), issue]),
      );
      assert.match(byWorkload["w2/w4"].message, /76 prompt tokens/);
      assert.match(byWorkload["w2/w4"].message, /between 20 and 64/);
      assert.match(byWorkload.w3.message, /1026 prompt tokens/);
      assert.match(byWorkload.w3.message, /between 2000 and 4095/);
      return true;
    },
  );
});

test("#25: a prompt long enough to be truncated is refused too, not just an out-of-band one", async () => {
  // The truncation signature is the other half of the shared rule: a count
  // pinned at num_ctx means the runtime cut the prompt, and a measurement of a
  // prompt that was never processed in full is worthless whether or not the
  // truncated count happens to land inside the band.
  const adapter = new FakeAdapter({ probePromptTokens: { w3: 4096 } });
  await assert.rejects(
    () => runBenchmark({ adapter, model: "fixture:8b" }),
    (error) =>
      error.issues.some(
        (issue) => issue.code === "prompt-truncated-precondition",
      ),
  );
});

test("#25: the refusal is overridable, and the condition is recorded on the record", async () => {
  const adapter = new FakeAdapter({ probePromptTokens: { w2: 68, w4: 68 } });
  const record = await runBenchmark({
    adapter,
    model: "fixture:8b",
    memoryBandwidthGBps: 500,
    qualityOverride: true,
  });
  // Overriding runs the protocol in full. It does not, and must not, relax
  // §5.4: the probe said the prompt misses the band, so the measured passes
  // miss it too and the run reports what it actually measured.
  assert.equal(adapter.calls.w2, 6);
  assert.equal(record.qualityOverride, true);
  assert.equal(record.cohortEligible, false);
  assert.deepEqual(record.qualityConditions, [
    { code: "prompt-count-out-of-range-precondition", detected: true },
  ]);
});

test("#25: the machine-state gate still runs first, so no model is loaded onto a bad machine", async () => {
  const adapter = new FakeAdapter({
    issues: [{ code: "gpu-utilization", message: "GPU utilization above 10%" }],
    probePromptTokens: { w2: 68, w4: 68 },
  });
  await assert.rejects(
    () => runBenchmark({ adapter, model: "fixture:8b" }),
    (error) => error.issues[0].code === "gpu-utilization",
  );
  assert.equal(
    adapter.calls.probe,
    0,
    "probing loads the model, which is exactly what the machine gate prevents",
  );
});

test("#25: an adapter that cannot probe is not blocked by the gate", async () => {
  // The probe is an optional adapter capability, on the same terms as
  // readEnvironment. A future adapter for a runtime with no equivalent call
  // loses the early refusal, not the ability to run.
  const adapter = new FakeAdapter({ probePromptTokens: { w2: 68, w4: 68 } });
  adapter.probePrompt = undefined;
  const record = await runBenchmark({
    adapter,
    model: "fixture:8b",
    memoryBandwidthGBps: 500,
  });
  assert.equal(record.qualityConditions.length, 0);
  assert.equal(adapter.calls.w2, 6);
});

test("#25: an inconclusive probe does not convict the model", async () => {
  // A runtime that reports no prompt token count has said nothing about the
  // model. §5.4 stays the backstop it always was.
  const adapter = new FakeAdapter({ probePromptTokens: { w2: null, w3: null } });
  const record = await runBenchmark({
    adapter,
    model: "fixture:8b",
    memoryBandwidthGBps: 500,
  });
  assert.equal(record.qualityConditions.length, 0);
  assert.equal(adapter.calls.w2, 6);
});

test("#25: the W3 probe carries its own cache-bust marker, colliding with no measured call", async () => {
  // W3's prompt must diverge from token 0 on every request or the run seeds
  // the prefix cache it exists to defeat. A probe reusing a measured call's
  // marker would hand W3's warmup a cache hit.
  const adapter = new FakeAdapter();
  await runBenchmark({
    adapter,
    model: "fixture:8b",
    memoryBandwidthGBps: 500,
  });
  const w3Probe = adapter.probedPrompts.find((prompt) =>
    prompt.includes("cache-bust w3#"),
  );
  assert.ok(w3Probe, "the W3 probe must carry a cache-bust marker");
  assert.equal(
    adapter.seenPrompts.w3.includes(w3Probe),
    false,
    "the probe's prompt must not equal any measured W3 prompt",
  );
});
