import test from "node:test";
import assert from "node:assert/strict";
import {
  GPU_MEMORY_BANDWIDTH_TABLE,
  __test,
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

test("bandwidth entries require source tier and a dated archive snapshot", () => {
  assert.equal(GPU_MEMORY_BANDWIDTH_TABLE.schemaVersion, "osai-gpu-memory-bandwidth/2");
  const [rtx3080, rtx4070Ti] = GPU_MEMORY_BANDWIDTH_TABLE.entries;
  assert.equal(rtx3080.sourceTier, 1);
  assert.equal(rtx3080.source.archiveDate, "2023-06-20");
  assert.equal(rtx4070Ti.sourceTier, 3);
  assert.equal(rtx4070Ti.source.archiveDate, "2025-01-15");
  for (const entry of GPU_MEMORY_BANDWIDTH_TABLE.entries) {
    assert.equal(__test.hasDurableManufacturerSource(entry), true);
    assert.match(
      entry.source.archiveUrl,
      /^https:\/\/web\.archive\.org\/web\/\d{14}\//,
    );
  }
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

test("an otherwise matching entry without durable provenance is unavailable", () => {
  const malformedTable = {
    schemaVersion: "test/1",
    entries: [
      {
        id: "missing-archive",
        match: {
          detectionNames: ["Synthetic GPU"],
          nominalVramMiB: 8192,
        },
        memoryBandwidthGBps: 500,
        sourceTier: 3,
        source: {
          manufacturer: "Synthetic",
          title: "Synthetic article",
          url: "https://example.test/source",
          locator: "Table 1",
        },
      },
    ],
  };
  assert.equal(
    matchGpuMemoryBandwidth(
      {
        model: "Synthetic GPU",
        totalVramBytes: 8192 * 1024 ** 2,
      },
      malformedTable,
    ),
    null,
  );
});
