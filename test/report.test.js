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
