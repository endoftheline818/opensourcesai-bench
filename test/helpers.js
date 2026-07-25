import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractRawMeasurement } from "../src/derivation/ollama.js";
import { validatePass } from "../src/derivation/validity.js";
import { validateFixtureFormat } from "../src/fixture-format.js";
import { WORKLOADS } from "../src/protocol.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function loadFixture(name) {
  const fixturePath = path.isAbsolute(name)
    ? name
    : path.join(testDirectory, "..", "fixtures", name);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  return validateFixtureFormat(fixture);
}

function pass(attemptResponses, workload, index) {
  const attempts = attemptResponses.map((response) => {
    const measurement = extractRawMeasurement(response);
    return {
      measurement,
      validity: validatePass(measurement, workload),
    };
  });
  const finalAttempt = attempts.at(-1);
  return {
    index,
    valid: finalAttempt.validity.valid,
    attempts,
    measurement: finalAttempt.measurement,
    validity: finalAttempt.validity,
  };
}

export async function normalRecord(
  fixtureName = "synthetic-normal.json",
) {
  const fixture = await loadFixture(fixtureName);
  const workloads = {};
  for (const [id, slots] of Object.entries(fixture.workloads)) {
    const workload = WORKLOADS[id];
    const warmupResponses = workload.warmups > 0 ? slots[0] : null;
    const measuredSlots = workload.warmups > 0 ? slots.slice(1) : slots;
    const measuredPasses = measuredSlots.map((attemptResponses, index) =>
      pass(attemptResponses, workload, index + 1),
    );
    workloads[id] = {
      warmup: warmupResponses
        ? extractRawMeasurement(warmupResponses[0])
        : null,
      measuredPasses,
      failed: measuredPasses.some((entry) => !entry.valid),
    };
  }
  return {
    protocolVersion: "osai-bench/1.1",
    clientVersion: "0.4.0",
    scoringVersion: "osai-bench-derive/1.2",
    createdAt: "2026-07-25T00:00:00.000Z",
    qualityOverride: false,
    cohortEligible: true,
    qualityConditions: [],
    runtime: {
      name: "ollama",
      version: "0.30.10",
      endpoint: "loopback",
      layerAssignment: null,
      kvCacheMetadata: {
        source: "ollama.show.model_info",
        architecture: "fixture",
        blockCount: 32,
        kvHeadCount: 8,
        attentionHeadCount: 32,
        embeddingLength: 4096,
        headDimension: 128,
        resolvedElementType: null,
        projectedBytes: null,
        calculationAvailable: false,
        missingInputs: ["resolvedKvCacheElementType"],
      },
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
      memoryBandwidthSource: "manual",
      memoryBandwidthTableVersion: null,
      memoryBandwidthEntryId: null,
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

export class FixtureAdapter {
  constructor(fixture, { system = null } = {}) {
    this.fixture = validateFixtureFormat(structuredClone(fixture));
    this.system = system ?? {
      cpu: { model: "Synthetic CPU" },
      gpu: {
        present: true,
        model: "Synthetic GPU",
        totalVramBytes: 12 * 1024 ** 3,
        freeVramBytes: 8 * 1024 ** 3,
        utilizationPercent: 0,
        driverVersion: "1.2.3",
        provider: "fixture",
      },
      gpuCount: 1,
      gpuProcesses: [],
      memory: { totalBytes: 32 * 1024 ** 3 },
      os: { platform: "linux", version: "Fixture", architecture: "x64" },
      power: { present: false, onBattery: false },
    };
    this.positions = Object.fromEntries(
      Object.keys(WORKLOADS).map((id) => [id, { slot: 0, attempt: 0 }]),
    );
  }

  async detect() {
    return { available: true, raw: { version: "fixture" } };
  }

  async listModels() {
    return structuredClone(this.fixture.tagsResponse);
  }

  async showModel() {
    return structuredClone(this.fixture.showResponse);
  }

  async listRunningModels() {
    return { models: [] };
  }

  async forceUnload() {
    return { chunks: [{ done: true }], timeToFirstTokenMs: null };
  }

  async collectSystemSnapshot() {
    return structuredClone(this.system);
  }

  async checkModelIndependentPreconditions() {
    return { issues: [], system: await this.collectSystemSnapshot() };
  }

  async checkModelDependentPreconditions() {
    return { issues: [], rawRunningModels: { models: [] } };
  }

  async checkPreconditions() {
    return {
      issues: [],
      system: await this.collectSystemSnapshot(),
      rawRunningModels: { models: [] },
    };
  }

  async generate(_model, workload) {
    const position = this.positions[workload.id];
    const slots = this.fixture.workloads[workload.id];
    const attempts = slots[position.slot];
    if (!attempts) {
      throw new Error(`Fixture exhausted for ${workload.id}`);
    }
    const response = attempts[position.attempt];
    if (!response) {
      throw new Error(
        `Fixture attempt sequence exhausted for ${workload.id} slot ${position.slot + 1}`,
      );
    }
    position.attempt += 1;
    if (position.attempt === attempts.length) {
      position.slot += 1;
      position.attempt = 0;
    }
    return structuredClone(response);
  }
}
