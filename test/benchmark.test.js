import test from "node:test";
import assert from "node:assert/strict";
import {
  QualityRefusalError,
  runBenchmark,
} from "../src/benchmark.js";

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
  constructor({ issues = [], retryW2 = false, failW4 = false, failW1 = false } = {}) {
    this.issues = issues;
    this.retryW2 = retryW2;
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
    let evalCount = workload.numPredict;
    if (this.retryW2 && workload.id === "w2" && this.calls.w2 === 2) {
      evalCount -= 1;
    }
    if (this.failW4 && workload.id === "w4" && this.calls.w4 > 1) {
      evalCount -= 1;
    }
    const promptCount =
      workload.intendedPromptTokens ?? (workload.id === "w1" ? 5 : 32);
    const evalDuration =
      workload.id === "w4" ? 8_000_000_000 : 1_000_000_000;
    return {
      chunks: [
        {
          response: "not persisted",
          done: true,
          total_duration: 10_000_000_000,
          load_duration: this.failW1 && workload.id === "w1" ? 0 : 1_000_000_000,
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
  assert.equal(record.derived.failureRate.percent, 0);
  assert.equal(record.protocolVersion, "osai-bench/1");
  assert.equal(record.clientVersion, "0.1.0");
  assert.equal(record.scoringVersion, "osai-bench-derive/1");
  assert.equal(JSON.stringify(record).includes("not persisted"), false);
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
  assert.equal(record.derived.failureRate.percent, 25);
});

test("W1 runs once and records failure without retry", async () => {
  const adapter = new FakeAdapter({ failW1: true });
  const record = await runBenchmark({ adapter, model: "fixture:8b" });
  assert.equal(adapter.calls.w1, 1);
  assert.equal(record.rawMeasurements.workloads.w1.failed, true);
  assert.equal(record.rawMeasurements.workloads.w1.measuredPasses[0].attempts.length, 1);
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
