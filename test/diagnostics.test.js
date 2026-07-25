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
      kvCacheMetadata: {
        architecture: "synthetic",
        blockCount: 32,
        kvHeadCount: 8,
        attentionHeadCount: 32,
        embeddingLength: 4096,
        headDimension: 128,
        resolvedElementType: null,
      },
    },
    configuration: { workloads: { w3: { numCtx: 4096 } } },
    ...overrides,
  };
}

function byId(diagnostics, id) {
  return diagnostics.find((diagnostic) => diagnostic.id === id);
}

test("available diagnostics derive from explicit evidence while KV headroom stays unavailable", () => {
  const value = input();
  value.model.weightsBytes = 13_000;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "detected");
  assert.equal(byId(diagnostics, "context-vram-headroom").status, "unavailable");
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

test("full GPU offload is not partial CPU offload", () => {
  const value = input();
  value.runtime.layerAssignment = {
    totalLayers: 33,
    gpuLayers: 33,
    cpuLayers: 0,
  };
  assert.equal(
    byId(deriveDiagnostics(value), "partial-cpu-offload").status,
    "not-detected",
  );
});

test("CPU-only execution is not also labelled partial CPU offload", () => {
  const value = input();
  value.runtime.layerAssignment = {
    totalLayers: 33,
    gpuLayers: 0,
    cpuLayers: 33,
  };
  assert.equal(
    byId(deriveDiagnostics(value), "partial-cpu-offload").status,
    "not-detected",
  );
});

test("missing layer/headroom evidence is reported unavailable, never inferred", () => {
  const value = input();
  value.runtime.layerAssignment = null;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "unavailable");
  assert.equal(byId(diagnostics, "context-vram-headroom").status, "unavailable");
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "unavailable");
  assert.equal(
    byId(diagnostics, "context-vram-headroom").evidence.missingInput,
    "resolvedKvCacheElementType",
  );
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
