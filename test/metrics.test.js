import test from "node:test";
import assert from "node:assert/strict";
import {
  coldLoadSeconds,
  deriveMetrics,
  generationTokensPerSecond,
  prefillTokensPerSecond,
} from "../src/derivation/metrics.js";
import { normalRecord } from "./helpers.js";

test("per-pass throughput and cold-load formulas use Ollama nanosecond counters", () => {
  assert.equal(
    generationTokensPerSecond({ eval_count: 512, eval_duration: 8e9 }),
    64,
  );
  assert.equal(
    prefillTokensPerSecond({
      prompt_eval_count: 4096,
      prompt_eval_duration: 2e9,
    }),
    2048,
  );
  assert.equal(coldLoadSeconds({ load_duration: 3e9 }), 3);
});

test("headline metrics are medians and CVs across five measured passes", async () => {
  const record = await normalRecord();
  const derived = deriveMetrics(record);
  assert.equal(derived.generationTokensPerSecond.samples, 5);
  assert.equal(derived.generationTokensPerSecond.median, 512 / 7.8);
  assert.ok(derived.generationTokensPerSecond.coefficientOfVariation > 0);
  assert.equal(derived.prefillTokensPerSecond.median, 4096 / 1.98);
  assert.equal(derived.timeToFirstTokenMs.median, 220);
  assert.equal(derived.coldLoad.seconds, 3);
  assert.deepEqual(derived.failureRate, {
    failedMeasuredPasses: 0,
    totalMeasuredPasses: 16,
    percent: 0,
  });
});

test("total_duration is recorded but ignored by every derived formula", async () => {
  const record = await normalRecord();
  const before = deriveMetrics(record);
  for (const workload of Object.values(record.rawMeasurements.workloads)) {
    for (const pass of workload.measuredPasses) {
      pass.measurement.total_duration *= 1000;
    }
  }
  const after = deriveMetrics(record);
  assert.equal(
    after.generationTokensPerSecond.median,
    before.generationTokensPerSecond.median,
  );
  assert.equal(
    after.prefillTokensPerSecond.median,
    before.prefillTokensPerSecond.median,
  );
  assert.equal(after.coldLoad.seconds, before.coldLoad.seconds);
});

test("roofline follows bandwidth / decimal-GB weights and generation ratio", async () => {
  const record = await normalRecord();
  const derived = deriveMetrics(record);
  assert.equal(derived.roofline.modelWeightsGB, 5);
  assert.equal(derived.roofline.theoreticalMaxTokensPerSecond, 100);
  assert.equal(
    derived.roofline.utilization,
    derived.generationTokensPerSecond.median / 100,
  );
});

test("roofline is unavailable without either denominator input", async () => {
  const record = await normalRecord();
  record.configuration.memoryBandwidthGBps = null;
  assert.equal(deriveMetrics(record).roofline.utilization, null);
  record.configuration.memoryBandwidthGBps = 500;
  record.model.weightsBytes = null;
  assert.equal(deriveMetrics(record).roofline.utilization, null);
});

test("failed workload is retained, counted, and excluded from headline metric", async () => {
  const record = await normalRecord();
  record.rawMeasurements.workloads.w4.failed = true;
  record.rawMeasurements.workloads.w4.measuredPasses[0].valid = false;
  const derived = deriveMetrics(record);
  assert.equal(derived.generationTokensPerSecond.median, null);
  assert.deepEqual(derived.failureRate, {
    failedMeasuredPasses: 1,
    totalMeasuredPasses: 16,
    percent: 6.25,
  });
});
