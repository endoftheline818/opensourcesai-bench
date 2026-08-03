import test from "node:test";
import assert from "node:assert/strict";
import { deriveMetrics } from "../src/derivation/metrics.js";
import { renderReport } from "../src/output/report.js";
import { ROOFLINE_LIMITS } from "../src/protocol.js";
import { normalRecord } from "./helpers.js";

test("human report displays every required measurement and roofline limit", async () => {
  const record = await normalRecord();
  record.derived = deriveMetrics(record);
  const report = renderReport(record);
  for (const label of [
    "Generation throughput",
    "Prefill throughput",
    "Time to first token",
    "Cold load time",
    "Pass failure rate",
    "Attempt failure rate",
    "Roofline utilization",
    "Diagnostics",
    "Configuration",
  ]) {
    assert.match(report, new RegExp(label));
  }
  for (const limit of ROOFLINE_LIMITS) assert.ok(report.includes(limit));
  assert.doesNotMatch(report, /setup score|letter grade|well-configured/i);
});

test("time to first visible token is omitted from an ordinary report", async () => {
  const record = await normalRecord();
  record.derived = deriveMetrics(record);
  const report = renderReport(record);
  assert.doesNotMatch(report, /Time to first visible token/);
  assert.doesNotMatch(report, /reasoning withheld/);
});

test("reasoning-withheld passes are annotated on the TTFT line, and the visible-token line appears once real values exist", async () => {
  const record = await normalRecord();
  const w2Passes = record.rawMeasurements.workloads.w2.measuredPasses;
  w2Passes[0].measurement.timeToFirstTokenMs = null;
  const w4Passes = record.rawMeasurements.workloads.w4.measuredPasses;
  w4Passes.forEach((pass, index) => {
    pass.measurement.timeToFirstVisibleTokenMs = 140_000 + index * 1000;
  });
  record.derived = deriveMetrics(record);
  const report = renderReport(record);
  assert.match(
    report,
    /Time to first token .*\[1\/5 pass\(es\): reasoning withheld the entire streamed response\]/,
  );
  assert.match(report, /Time to first visible token\s+142000\.00 ms/);
});

test("report says roofline unavailable when denominator input is missing", async () => {
  const record = await normalRecord();
  record.configuration.memoryBandwidthGBps = null;
  record.derived = deriveMetrics(record);
  const report = renderReport(record);
  assert.match(report, /Roofline utilization\s+unavailable/);
});

test("report identifies both failure denominators and bandwidth source", async () => {
  const record = await normalRecord();
  record.rawMeasurements.workloads.w4.failed = true;
  record.rawMeasurements.workloads.w4.measuredPasses[0].valid = false;
  record.rawMeasurements.workloads.w4.measuredPasses[0].attempts[0].validity.valid =
    false;
  record.derived = deriveMetrics(record);
  const report = renderReport(record);
  assert.match(report, /1\/16 scheduled measured passes/);
  assert.match(report, /1\/16 measured-pass attempts/);
  assert.match(report, /500\.00 GB\/s \(manual\)/);
  assert.doesNotMatch(report, /workloads\)/);
});
