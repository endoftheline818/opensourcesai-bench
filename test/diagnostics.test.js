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

// --- opensourcesai-bench#24: an accelerator our detector cannot see ----------
//
// GPU detection is nvidia-smi-only. On Apple Metal (and ROCm) `gpu.present` is
// false, and the placement diagnostics used to short-circuit on that and assert
// "the run is labelled CPU-only" — while the same record carried Ollama's own
// `vramResidentFraction: 1`. Both figures below are the real M1 run
// (2026-08-09, qwen3:4b Q4_K_M, 18.08 tok/s).

function undetectedAcceleratorInput(vramResidentBytes = 2_895_118_335) {
  const value = input();
  value.system.gpu = {
    present: false,
    model: null,
    totalVramBytes: null,
    freeVramBytesAtLoad: null,
  };
  value.model.weightsBytes = 2_497_293_931;
  // No layer assignment: Ollama does not report one here, which is precisely
  // why the byte-granular placement figure is the only evidence available.
  value.runtime.layerAssignment = null;
  value.runtime.offloadPlacement = {
    source: "ollama.ps.size_vram",
    granularity: "bytes",
    residentBytes: 2_895_118_335,
    vramResidentBytes,
    hostResidentBytes: 2_895_118_335 - vramResidentBytes,
    vramResidentFraction: vramResidentBytes / 2_895_118_335,
  };
  return value;
}

test("#24: no diagnostic claims CPU-only when the runtime reports the model device-resident", () => {
  const diagnostics = deriveDiagnostics(undetectedAcceleratorInput());

  // The regression in one assertion. Note the lookbehind: what must never
  // appear is the CLAIM that the run is CPU-only, not the token — a message
  // reading "this run is not CPU-only" is the correction, not the defect.
  // (The first draft of this test matched the bare token and failed against its
  // own fix: the same search-the-token-not-the-claim error, in miniature.)
  for (const diagnostic of diagnostics) {
    assert.equal(
      /(?<!not )CPU-only/.test(diagnostic.message),
      false,
      `"${diagnostic.id}" still asserts CPU-only: ${diagnostic.message}`,
    );
  }

  // And the record must say something true instead of merely staying silent.
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "not-detected");
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-detected");
  assert.match(
    byId(diagnostics, "cpu-only-with-gpu").message,
    /100% of the model's resident bytes are in VRAM/,
  );

  // Capacity is genuinely unknown, not inapplicable: nvidia-smi supplies the
  // total and there is none. `not-applicable` would assert the question is
  // meaningless, which is the same category error as the CPU-only label.
  assert.equal(byId(diagnostics, "weights-exceed-vram").status, "unavailable");
});

test("#24: a partial split on an undetected accelerator is still reported as a split", () => {
  // Half the bytes on the host. The old code reported `not-applicable` here too,
  // hiding a real offload — the failure mode that matters most, since offload is
  // the thing these diagnostics exist to surface.
  const diagnostics = deriveDiagnostics(
    undetectedAcceleratorInput(1_447_559_167),
  );
  const partial = byId(diagnostics, "partial-cpu-offload");
  assert.equal(partial.status, "detected");
  assert.match(partial.message, /50% of the model's resident bytes are on the host/);
});

test("#24 must not regress: a genuinely GPU-less machine keeps the CPU-only label", () => {
  // §7.2's forced-state table records `num_gpu 0` -> `size_vram: 0`, so this is
  // what real CPU-only execution looks like. Deliberate CPU-only on Windows or
  // Linux is in scope per §3 and its label is correct — the fix must not have
  // widened into it.
  const diagnostics = deriveDiagnostics(undetectedAcceleratorInput(0));
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "not-applicable");
  assert.match(byId(diagnostics, "partial-cpu-offload").message, /CPU-only/);
  assert.equal(byId(diagnostics, "cpu-only-with-gpu").status, "not-applicable");
  assert.equal(byId(diagnostics, "weights-exceed-vram").status, "not-applicable");
});

test("#24 must not regress: no placement figures at all stays unavailable, not invented", () => {
  const value = undetectedAcceleratorInput();
  value.runtime.offloadPlacement = null;
  const diagnostics = deriveDiagnostics(value);
  assert.equal(byId(diagnostics, "partial-cpu-offload").status, "not-applicable");
});
