import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateRunSeconds,
  formatDuration,
  renderRunEstimate,
} from "../src/output/estimate.js";
import { WORKLOADS } from "../src/protocol.js";

test("the estimate is derived from scheduled pass counts, not a constant", () => {
  const scheduled = Object.values(WORKLOADS).reduce(
    (sum, workload) => sum + workload.repetitions + workload.warmups,
    0,
  );
  // 1 cold pass + three workloads at 1 warmup + 5 measured each.
  assert.equal(scheduled, 19);
  const seconds = estimateRunSeconds();
  assert.ok(seconds > 0);
  // Sanity bounds rather than an exact figure: this is an estimate, and pinning
  // it exactly would make the test a change-detector rather than a check.
  assert.ok(seconds > 60, "a full protocol run is never under a minute");
  assert.ok(seconds < 3600, "an estimate over an hour indicates a unit error");
});

test("durations render in human units", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(120), "2m");
  assert.equal(formatDuration(150), "2m 30s");
});

test("the estimate is labelled as an estimate and names the dominant workload", () => {
  const rendered = renderRunEstimate();
  assert.match(rendered, /estimate/i);
  assert.match(rendered, /w3/);
  assert.match(rendered, new RegExp(String(WORKLOADS.w3.numCtx)));
  // Retries extend a run beyond the estimate; saying so up front avoids the
  // estimate reading as a promise.
  assert.match(rendered, /retr/i);
});
