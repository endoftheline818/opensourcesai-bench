import test from "node:test";
import assert from "node:assert/strict";
import { deriveDiagnostics } from "../src/derivation/diagnostics.js";

function input(overrides = {}) {
  return {
    system: {
      gpu: {
        present: true,
        model: "Synthetic GPU",
        totalVramBytes: 12_000,
        freeVramBytesAtLoad: 6_000,
      },
    },
    model: { weightsBytes: 5_000 },
    runtime: {
      layerAssignment: { totalLayers: 33, gpuLayers: 26, cpuLayers: 7 },
      contextMemoryRequiredBytes: 4_000,
    },
    configuration: { workloads: { w3: { numCtx: 4096 } } },
    ...overrides,
  };
}

function byId(diagnostics, id) {
  return diagnostics.find((diagnostic) => diagnostic.id === id);
}

test("all four detected-condition diagnostics derive from explicit evidence", () => {
  const value = input();
  value.runtime.contextMemoryRequiredBytes = 8_000;
  value.model.weightsBytes = 13_000;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "detected");
  assert.equal(byId(diagnostics, "context-vram-headroom").status, "detected");
  assert.equal(byId(diagnostics, "weights-exceed-vram").status, "detected");
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-detected");
});

test("CPU-only execution is detected when a present GPU has zero GPU layers", () => {
  const value = input();
  value.runtime.layerAssignment = {
    totalLayers: 33,
    gpuLayers: 0,
    cpuLayers: 33,
  };
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "detected");
});

test("literal §7 CPU-layers-less-than-total rule remains unchanged", () => {
  const value = input();
  value.runtime.layerAssignment = {
    totalLayers: 33,
    gpuLayers: 33,
    cpuLayers: 0,
  };
  assert.equal(
    byId(deriveDiagnostics(value), "partial-cpu-offload").status,
    "detected",
  );
});

test("missing layer/headroom evidence is reported unavailable, never inferred", () => {
  const value = input();
  value.runtime.layerAssignment = null;
  value.runtime.contextMemoryRequiredBytes = null;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "unavailable");
  assert.equal(byId(diagnostics, "context-vram-headroom").status, "unavailable");
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "unavailable");
});

test("GPU diagnostics are not applicable for a CPU-only labelled setup", () => {
  const value = input({
    system: {
      gpu: {
        present: false,
        model: null,
        totalVramBytes: null,
        freeVramBytesAtLoad: null,
      },
    },
  });
  value.runtime.layerAssignment = null;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-applicable");
  assert.equal(byId(diagnostics, "weights-exceed-vram").status, "not-applicable");
});
