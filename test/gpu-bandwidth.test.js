import test from "node:test";
import assert from "node:assert/strict";
import {
  GPU_MEMORY_BANDWIDTH_TABLE,
  matchGpuMemoryBandwidth,
  resolveGpuMemoryBandwidth,
} from "../src/derivation/gpu-bandwidth.js";

test("collector detection names and VRAM select only an exact sourced variant", () => {
  const match = matchGpuMemoryBandwidth({
    model: "  NVIDIA   GeForce RTX 3080 ",
    totalVramBytes: 10240 * 1024 ** 2,
  });
  assert.equal(match.id, "nvidia-geforce-rtx-3080-10gb");
  assert.equal(match.memoryBandwidthGBps, 760);

  assert.equal(
    matchGpuMemoryBandwidth({
      model: "NVIDIA GeForce RTX 3080",
      totalVramBytes: 12288 * 1024 ** 2,
    }),
    null,
  );
  assert.equal(
    matchGpuMemoryBandwidth({
      model: "NVIDIA GeForce RTX 3080 Ti",
      totalVramBytes: 12288 * 1024 ** 2,
    }),
    null,
  );
});

test("manual bandwidth overrides a matching table row", () => {
  assert.deepEqual(
    resolveGpuMemoryBandwidth({
      manualGBps: 777,
      model: "NVIDIA GeForce RTX 3080",
      totalVramBytes: 10240 * 1024 ** 2,
    }),
    {
      memoryBandwidthGBps: 777,
      source: "manual",
      tableVersion: null,
      entryId: null,
    },
  );
});

test("missing or ambiguous table input remains unavailable", () => {
  assert.deepEqual(
    resolveGpuMemoryBandwidth({
      model: "Unsourced Synthetic GPU",
      totalVramBytes: 8 * 1024 ** 3,
    }),
    {
      memoryBandwidthGBps: null,
      source: null,
      tableVersion: GPU_MEMORY_BANDWIDTH_TABLE.schemaVersion,
      entryId: null,
    },
  );
});
