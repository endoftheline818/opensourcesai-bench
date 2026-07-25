import test from "node:test";
import assert from "node:assert/strict";
import {
  coldLoadSeconds,
  deriveMetrics,
  generationTokensPerSecond,
  prefillTokensPerSecond,
} from "../src/derivation/metrics.js";
import { loadFixture, normalRecord } from "./helpers.js";

test("per-pass throughput and cold-load formulas use Ollama nanosecond counters", () => {
  assert.equal(
    generationTokensPerSecond({ eval_count: 512, eval_duration: 8e9 }),
    64,
  );
  assert.equal(
    prefillTokensPerSecond({
      prompt_eval_count: 3100,
      prompt_eval_duration: 2e9,
    }),
    1550,
  );
  assert.equal(coldLoadSeconds({ load_duration: 3e9 }), 3);
});

test("headline metrics are medians and CVs across five measured passes", async () => {
  const record = await normalRecord();
  const derived = deriveMetrics(record);
  assert.equal(derived.generationTokensPerSecond.samples, 5);
  assert.equal(derived.generationTokensPerSecond.median, 512 / 7.8);
  assert.ok(derived.generationTokensPerSecond.coefficientOfVariation > 0);
  assert.equal(derived.prefillTokensPerSecond.median, 3100 / 1.98);
  assert.equal(derived.timeToFirstTokenMs.median, 220);
  assert.equal(derived.coldLoad.seconds, 3);
  assert.deepEqual(derived.passFailureRate, {
    failedMeasuredPasses: 0,
    totalMeasuredPasses: 16,
    percent: 0,
  });
  assert.deepEqual(derived.attemptFailureRate, {
    failedAttempts: 0,
    totalAttempts: 16,
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
  record.rawMeasurements.workloads.w4.measuredPasses[0].attempts[0].validity.valid =
    false;
  const derived = deriveMetrics(record);
  assert.equal(derived.generationTokensPerSecond.median, null);
  assert.deepEqual(derived.passFailureRate, {
    failedMeasuredPasses: 1,
    totalMeasuredPasses: 16,
    percent: 6.25,
  });
  assert.deepEqual(derived.attemptFailureRate, {
    failedAttempts: 1,
    totalAttempts: 16,
    percent: 6.25,
  });
});

test("synthetic retry-then-succeed fixture separates attempt failures from pass failures", async () => {
  const fixture = await loadFixture("synthetic-retry-then-succeed.json");
  const record = await normalRecord();
  const recoveredPass =
    record.rawMeasurements.workloads.w2.measuredPasses[0];
  recoveredPass.attempts = fixture.attempts;
  recoveredPass.valid = true;
  recoveredPass.measurement = fixture.attempts.at(-1).measurement;
  recoveredPass.validity = fixture.attempts.at(-1).validity;

  const derived = deriveMetrics(record);
  assert.deepEqual(derived.passFailureRate, {
    failedMeasuredPasses: 0,
    totalMeasuredPasses: 16,
    percent: 0,
  });
  assert.deepEqual(derived.attemptFailureRate, {
    failedAttempts: 1,
    totalAttempts: 17,
    percent: (1 / 17) * 100,
  });
});
