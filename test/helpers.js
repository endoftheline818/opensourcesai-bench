import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractRawMeasurement } from "../src/derivation/ollama.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function loadFixture(name) {
  return JSON.parse(
    await readFile(path.join(testDirectory, "..", "fixtures", name), "utf8"),
  );
}

function pass(measurement, index) {
  const validity = { valid: true, reasons: [] };
  return {
    index,
    valid: true,
    attempts: [{ measurement, validity }],
    measurement,
    validity,
  };
}

export async function normalRecord() {
  const fixture = await loadFixture("synthetic-normal.json");
  const workloads = {};
  for (const [id, responses] of Object.entries(fixture.workloads)) {
    const measurements = responses.map(extractRawMeasurement);
    workloads[id] = {
      warmup: id === "w1" ? null : measurements[0],
      measuredPasses:
        id === "w1"
          ? [pass(measurements[0], 1)]
          : measurements
              .slice(1)
              .map((measurement, index) => pass(measurement, index + 1)),
      failed: false,
    };
  }
  return {
    protocolVersion: "osai-bench/1",
    clientVersion: "0.1.0",
    scoringVersion: "osai-bench-derive/1",
    createdAt: "2026-07-25T00:00:00.000Z",
    qualityOverride: false,
    cohortEligible: true,
    qualityConditions: [],
    runtime: {
      name: "ollama",
      version: "0.30.10",
      endpoint: "loopback",
      layerAssignment: null,
      contextMemoryRequiredBytes: null,
    },
    model: {
      identifier: "fixture-model:8b-q4",
      digest: "sha256:synthetic-normal",
      family: "fixture",
      parameterSize: "8B",
      quantization: "Q4_K_M",
      weightsBytes: 5_000_000_000,
      weightsSource: "ollama.tags.size",
    },
    system: {
      cpu: { model: "Synthetic CPU" },
      gpu: {
        present: true,
        model: "Synthetic GPU",
        totalVramBytes: 12 * 1024 ** 3,
        freeVramBytesAtCheck: 11 * 1024 ** 3,
        freeVramBytesAtLoad: 6 * 1024 ** 3,
        utilizationPercentAtCheck: 0,
        driverVersion: "595.71.05",
        provider: "nvidia-smi",
      },
      memory: { totalBytes: 32 * 1024 ** 3 },
      os: { platform: "linux", version: "Synthetic Linux", architecture: "x64" },
      power: { present: false, onBattery: false },
    },
    configuration: {
      memoryBandwidthGBps: 500,
      fixedOptions: { temperature: 0, seed: 42, stream: true },
      workloads: {
        w1: { numCtx: 512 },
        w2: { numCtx: 4096 },
        w3: { numCtx: 4096 },
        w4: { numCtx: 4096 },
      },
      resolved: {},
    },
    rawMeasurements: { workloads },
    derived: null,
  };
}
