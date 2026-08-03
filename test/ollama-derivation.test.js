import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLayerAssignment,
  extractKvCacheMetadata,
  extractModelMetadata,
  extractOffloadPlacement,
  extractRawMeasurement,
  finalOllamaChunk,
} from "../src/derivation/ollama.js";
import { loadFixture } from "./helpers.js";

test("final chunk and raw counters are extracted without retaining model output", async () => {
  const fixture = await loadFixture("synthetic-normal.json");
  const response = fixture.workloads.w2[0][0];
  const original = structuredClone(response.chunks);
  assert.equal(finalOllamaChunk(response.chunks).done, true);
  const measurement = extractRawMeasurement(response);
  assert.equal(measurement.eval_count, 128);
  assert.equal(measurement.timeToFirstTokenMs, 225);
  assert.equal("response" in measurement, false);
  assert.deepEqual(response.chunks, original);
});

test("timeToFirstVisibleTokenMs is carried through when the collection result has it", () => {
  const measurement = extractRawMeasurement({
    chunks: [{ done: true, eval_count: 16 }],
    timeToFirstTokenMs: 4200,
    timeToFirstVisibleTokenMs: 142_200,
  });
  assert.equal(measurement.timeToFirstTokenMs, 4200);
  assert.equal(measurement.timeToFirstVisibleTokenMs, 142_200);
});

test("timeToFirstVisibleTokenMs stays null when absent, including on fixtures predating the field", async () => {
  const fixture = await loadFixture("synthetic-normal.json");
  const response = fixture.workloads.w2[0][0];
  assert.equal("timeToFirstVisibleTokenMs" in response, false);
  const measurement = extractRawMeasurement(response);
  assert.equal(measurement.timeToFirstVisibleTokenMs, null);
});

test("/api/show architecture metadata is retained but KV projection stays unavailable without resolved element type", () => {
  const metadata = extractKvCacheMetadata({
    model_info: {
      "general.architecture": "llama",
      "llama.block_count": 32,
      "llama.attention.head_count": 32,
      "llama.attention.head_count_kv": 8,
      "llama.embedding_length": 4096,
    },
  });
  assert.deepEqual(metadata, {
    source: "ollama.show.model_info",
    architecture: "llama",
    blockCount: 32,
    kvHeadCount: 8,
    attentionHeadCount: 32,
    embeddingLength: 4096,
    headDimension: 128,
    resolvedElementType: null,
    projectedBytes: null,
    calculationAvailable: false,
    missingInputs: ["resolvedKvCacheElementType"],
  });
});

test("model metadata uses Ollama tags size provisionally", async () => {
  const fixture = await loadFixture("synthetic-normal.json");
  const model = extractModelMetadata(
    fixture.tagsResponse.models[0],
    fixture.showResponse,
  );
  assert.equal(model.weightsBytes, 5_000_000_000);
  assert.equal(model.weightsSource, "ollama.tags.size");
  assert.equal(model.quantization, "Q4_K_M");
});

test("layer assignment is accepted only from explicit machine-readable fields", () => {
  assert.deepEqual(
    extractLayerAssignment(
      {
        layer_assignment: {
          total_layers: 33,
          gpu_layers: 26,
          cpu_layers: 7,
        },
      },
      null,
    ),
    { totalLayers: 33, gpuLayers: 26, cpuLayers: 7, source: "ollama-api" },
  );
  assert.equal(
    extractLayerAssignment({}, { size: 10_000, size_vram: 8_000 }),
    null,
  );
});

// Byte figures below are real /api/ps readings captured 2026-07-26 on the
// RTX 4070 Ti (Ollama 0.32.3) and the RTX 3080 rig (0.30.10).
const FULL_GPU = { size: 5_020_141_485, size_vram: 5_020_141_485 };
const CPU_ONLY = { size: 5_316_154_489, size_vram: 0 };
const PARTIAL_4070TI = { size: 5_357_646_640, size_vram: 1_850_893_925 };
const PARTIAL_3080 = { size: 5_609_158_080, size_vram: 1_921_609_891 };

test("offload placement reads the real /api/ps byte pair", () => {
  assert.deepEqual(extractOffloadPlacement(FULL_GPU), {
    source: "ollama.ps.size_vram",
    granularity: "bytes",
    residentBytes: 5_020_141_485,
    vramResidentBytes: 5_020_141_485,
    hostResidentBytes: 0,
    vramResidentFraction: 1,
  });
  assert.equal(extractOffloadPlacement(CPU_ONLY).vramResidentFraction, 0);
  assert.equal(
    extractOffloadPlacement(CPU_ONLY).hostResidentBytes,
    5_316_154_489,
  );
});

test("placement fractions match what `ollama ps` printed for the same load", () => {
  // CLI printed "65%/35% CPU/GPU" for PARTIAL_4070TI at that moment.
  const a = extractOffloadPlacement(PARTIAL_4070TI);
  assert.equal(Math.round(a.vramResidentFraction * 100), 35);
  const b = extractOffloadPlacement(PARTIAL_3080);
  assert.equal(Math.round(b.vramResidentFraction * 100), 34);
});

test("placement is null when the byte pair is missing or incoherent", () => {
  for (const entry of [
    undefined,
    null,
    {},
    { size: 5_000 },
    { size_vram: 5_000 },
    { size: 0, size_vram: 0 },
    { size: -1, size_vram: 0 },
    { size: 5_000, size_vram: -1 },
    // Ollama's own CLI treats vram > size as Unknown rather than clamping.
    { size: 5_000, size_vram: 6_000 },
    { size: "5000", size_vram: "0" },
  ]) {
    assert.equal(
      extractOffloadPlacement(entry),
      null,
      `expected null for ${JSON.stringify(entry)}`,
    );
  }
});

test("bytes are never presented as a layer assignment", () => {
  // The same entry that yields a placement must still yield no layer data.
  assert.equal(extractLayerAssignment({}, PARTIAL_4070TI), null);
  assert.ok(extractOffloadPlacement(PARTIAL_4070TI));
  assert.equal(extractOffloadPlacement(PARTIAL_4070TI).granularity, "bytes");
});
