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

test("TTFT excludes reasoning-withheld nulls from median/CV and reports how many", async () => {
  const record = await normalRecord();
  const w2Passes = record.rawMeasurements.workloads.w2.measuredPasses;
  assert.equal(w2Passes.length, 5);
  // Simulate two passes where generation genuinely happened (eval_count
  // intact) but every streamed chunk stayed inside the thinking channel, so
  // TTFT never fired -- the case lab run 9 (2026-08-03, gemma4:31b) surfaced.
  assert.ok(w2Passes[0].measurement.eval_count > 0);
  w2Passes[0].measurement.timeToFirstTokenMs = null;
  w2Passes[1].measurement.timeToFirstTokenMs = null;
  const derived = deriveMetrics(record);
  assert.equal(derived.timeToFirstTokenMs.reasoningWithheldPasses, 2);
  // Before the fix, statistics.js's null-tolerant arithmetic would have kept
  // samples at 5 and silently dragged the median toward zero instead of
  // excluding the two withheld passes.
  assert.equal(derived.timeToFirstTokenMs.samples, 3);
  assert.ok(Number.isFinite(derived.timeToFirstTokenMs.median));
});

test("TTFT reports zero reasoning-withheld passes on an ordinary run", async () => {
  const record = await normalRecord();
  const derived = deriveMetrics(record);
  assert.equal(derived.timeToFirstTokenMs.reasoningWithheldPasses, 0);
  assert.equal(derived.timeToFirstTokenMs.samples, 5);
});

test("first-visible-token time is unavailable by default, including on fixtures that predate it", async () => {
  const record = await normalRecord();
  const derived = deriveMetrics(record);
  assert.equal(derived.timeToFirstVisibleTokenMs.samples, 0);
  assert.equal(derived.timeToFirstVisibleTokenMs.median, null);
});

test("first-visible-token time is derived from W4, not W2", async () => {
  const record = await normalRecord();
  const w4Passes = record.rawMeasurements.workloads.w4.measuredPasses;
  const values = [140_000, 141_000, 142_000, 143_000, 144_000];
  w4Passes.forEach((pass, index) => {
    pass.measurement.timeToFirstVisibleTokenMs = values[index];
  });
  // W2 is deliberately left untouched -- confirms the stat reads from W4
  // regardless of what W2 carries.
  const derived = deriveMetrics(record);
  assert.equal(derived.timeToFirstVisibleTokenMs.samples, 5);
  assert.equal(derived.timeToFirstVisibleTokenMs.median, 142_000);
});

test("synthetic retry-then-succeed fixture separates attempt failures from pass failures", async () => {
  const record = await normalRecord("synthetic-retry-then-succeed.json");
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
