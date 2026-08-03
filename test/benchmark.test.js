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

class FakeAdapter {
  constructor({
    issues = [],
    retryW2 = false,
    retryW1 = false,
    failW4 = false,
    failW1 = false,
  } = {}) {
    this.issues = issues;
    this.retryW2 = retryW2;
    this.retryW1 = retryW1;
    this.failW4 = failW4;
    this.failW1 = failW1;
    this.calls = { w1: 0, w2: 0, w3: 0, w4: 0, forceUnload: 0 };
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
  });
  assert.equal(record.rawMeasurements.workloads.w2.measuredPasses.length, 5);
  assert.equal(record.rawMeasurements.workloads.w2.warmup.eval_count, 128);
  assert.equal(record.derived.passFailureRate.percent, 0);
  assert.equal(record.derived.attemptFailureRate.percent, 0);
  assert.equal(record.protocolVersion, "osai-bench/1.3");
  assert.equal(record.clientVersion, CLIENT_VERSION);
  assert.equal(record.scoringVersion, "osai-bench-derive/1.4");
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
