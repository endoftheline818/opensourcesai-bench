import test from "node:test";
import assert from "node:assert/strict";
import { OllamaAdapter } from "../src/adapters/ollama.js";

function systemSnapshot(overrides = {}) {
  return {
    cpu: { model: "Test CPU" },
    gpu: {
      present: true,
      model: "Test GPU",
      totalVramBytes: 12 * 1024 ** 3,
      utilizationPercent: 0,
      driverVersion: "1.0",
    },
    gpuProcesses: [],
    gpuCount: 1,
    memory: { totalBytes: 32 * 1024 ** 3 },
    os: { platform: "linux" },
    power: { present: true, onBattery: false },
    ...overrides,
  };
}

class StubAdapter extends OllamaAdapter {
  constructor({ system = systemSnapshot(), running = { models: [] } } = {}) {
    super();
    this.stubSystem = system;
    this.stubRunning = running;
    this.snapshotCalls = 0;
  }

  async collectSystemSnapshot() {
    this.snapshotCalls += 1;
    return this.stubSystem;
  }

  async listRunningModels() {
    return this.stubRunning;
  }
}

test("the environment check reports model-independent conditions only", async () => {
  const adapter = new StubAdapter({
    system: systemSnapshot({ power: { present: true, onBattery: true } }),
    // A foreign model is loaded, but that is model-dependent and must not
    // surface here — otherwise the early refusal would fire before the user has
    // even chosen a target model.
    running: { models: [{ name: "some-other-model" }] },
  });
  const environment = await adapter.checkEnvironmentPreconditions();
  const codes = environment.issues.map((issue) => issue.code);
  assert.deepEqual(codes, ["on-battery"]);
  assert.equal(environment.system.gpu.model, "Test GPU");
});

test("the environment check catches contention and unsupported topologies", async () => {
  const busy = new StubAdapter({
    system: systemSnapshot({
      gpu: { ...systemSnapshot().gpu, utilizationPercent: 42 },
      gpuProcesses: [{ processName: "blender", usedMemoryMiB: 4096 }],
      gpuCount: 2,
    }),
  });
  const codes = (await busy.checkEnvironmentPreconditions()).issues.map(
    (issue) => issue.code,
  );
  assert.ok(codes.includes("gpu-utilization"));
  assert.ok(codes.includes("non-ollama-gpu-memory"));
  assert.ok(codes.includes("multiple-gpus-unsupported"));
});

test("the full check adds model-dependent conditions to the environment ones", async () => {
  const adapter = new StubAdapter({
    system: systemSnapshot({ power: { present: true, onBattery: true } }),
    running: { models: [{ name: "some-other-model" }] },
  });
  const codes = (await adapter.checkPreconditions("target-model")).issues.map(
    (issue) => issue.code,
  );
  assert.ok(codes.includes("on-battery"));
  assert.ok(codes.includes("different-model-loaded"));
});

test("passing an existing environment avoids a second system snapshot", async () => {
  // The CLI checks the environment before prompting, then hands the result to
  // the run. Without reuse that would cost two snapshots — including a second
  // round of nvidia-smi and CIM subprocess calls — per run.
  const adapter = new StubAdapter();
  const environment = await adapter.checkEnvironmentPreconditions();
  assert.equal(adapter.snapshotCalls, 1);
  await adapter.checkPreconditions("target-model", environment);
  assert.equal(adapter.snapshotCalls, 1);
});

test("the full check still stands alone when no environment is supplied", async () => {
  const adapter = new StubAdapter();
  const result = await adapter.checkPreconditions("target-model");
  assert.equal(adapter.snapshotCalls, 1);
  assert.deepEqual(result.issues, []);
  assert.equal(result.system.gpu.model, "Test GPU");
});
