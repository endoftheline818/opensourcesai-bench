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

// Real /api/ps readings, 2026-07-26. Baseline: layerAssignment is absent
// (Ollama never reports it), so these exercise the byte-granular route.
function placementInput(placement) {
  const value = input();
  value.runtime.layerAssignment = null;
  value.runtime.offloadPlacement = placement;
  return value;
}

const PARTIAL = {
  source: "ollama.ps.size_vram",
  granularity: "bytes",
  residentBytes: 5_357_646_640,
  vramResidentBytes: 1_850_893_925,
  hostResidentBytes: 3_506_752_715,
  vramResidentFraction: 1_850_893_925 / 5_357_646_640,
};
const CPU_ONLY = {
  source: "ollama.ps.size_vram",
  granularity: "bytes",
  residentBytes: 5_316_154_489,
  vramResidentBytes: 0,
  hostResidentBytes: 5_316_154_489,
  vramResidentFraction: 0,
};
const FULL_GPU = {
  source: "ollama.ps.size_vram",
  granularity: "bytes",
  residentBytes: 5_020_141_485,
  vramResidentBytes: 5_020_141_485,
  hostResidentBytes: 0,
  vramResidentFraction: 1,
};

test("partial offload is detected from bytes when no layer counts exist", () => {
  const diagnostics = deriveDiagnostics(placementInput(PARTIAL));
  const entry = byId(diagnostics, "partial-cpu-offload");
  assert.equal(entry.status, "detected");
  assert.match(entry.message, /65% of the model's resident bytes are on the host/);
  assert.equal(entry.evidence.granularity, "bytes");
});

test("CPU-only execution beside a present GPU is detected from zero VRAM bytes", () => {
  const diagnostics = deriveDiagnostics(placementInput(CPU_ONLY));
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "detected");
  // Everything resident on the host is not a *partial* split.
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "not-detected");
});

test("a fully resident model detects neither condition", () => {
  const diagnostics = deriveDiagnostics(placementInput(FULL_GPU));
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-detected");
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "not-detected");
});

test("both diagnostics stay unavailable when Ollama reported no sizes", () => {
  const diagnostics = deriveDiagnostics(placementInput(null));
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "unavailable");
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "unavailable");
});

test("with no GPU present neither diagnostic claims a finding", () => {
  const value = placementInput(CPU_ONLY);
  value.system.gpu.present = false;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "not-applicable");
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-applicable");
});

test("exact layer counts win over byte placement when both exist", () => {
  const value = placementInput(CPU_ONLY);
  value.runtime.layerAssignment = { totalLayers: 33, gpuLayers: 26, cpuLayers: 7 };
  const diagnostics = deriveDiagnostics(value);
  const entry = byId(diagnostics, "partial-cpu-offload");
  assert.equal(entry.status, "detected");
  assert.match(entry.message, /7 of 33 layers/);
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-detected");
});
