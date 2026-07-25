import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLayerAssignment,
  extractKvCacheMetadata,
  extractModelMetadata,
  extractRawMeasurement,
  finalOllamaChunk,
} from "../src/derivation/ollama.js";
import { loadFixture } from "./helpers.js";

test("final chunk and raw counters are extracted without retaining model output", async () => {
  const fixture = await loadFixture("synthetic-normal.json");
  const response = fixture.workloads.w2[0];
  const original = structuredClone(response.chunks);
  assert.equal(finalOllamaChunk(response.chunks).done, true);
  const measurement = extractRawMeasurement(response);
  assert.equal(measurement.eval_count, 128);
  assert.equal(measurement.timeToFirstTokenMs, 225);
  assert.equal("response" in measurement, false);
  assert.deepEqual(response.chunks, original);
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
