import test from "node:test";
import assert from "node:assert/strict";
import { runBenchmark } from "../src/benchmark.js";
import { PROTOCOL_VERSION, SCORING_VERSION, WORKLOADS } from "../src/protocol.js";
import { verifyResult } from "../src/derivation/verify.js";
import { renderVerifyReport } from "../src/output/verify-report.js";
import { FixtureAdapter, loadFixture } from "./helpers.js";

const CURRENT = {
  workloads: WORKLOADS,
  protocolVersion: PROTOCOL_VERSION,
  scoringVersion: SCORING_VERSION,
};

// A genuine record, produced by the ordinary code path from a committed
// real-hardware fixture rather than hand-assembled. A verifier tested only
// against records shaped for it proves nothing about the records it will
// actually be pointed at.
async function record() {
  const fixture = await loadFixture("real-baseline-rtx3080.json");
  const live = await runBenchmark({
    adapter: new FixtureAdapter(fixture),
    model: fixture.tagsResponse.models[0].name,
    memoryBandwidthGBps: 760,
  });
  // Round-tripped through JSON, because that is what a stored result is and
  // the difference matters: in memory a pass's measurement is the same OBJECT
  // as its final attempt's, so editing one edits both and the two copies
  // cannot be made to disagree. On disk they are separate copies. A verifier
  // tested only in memory would never see the case it exists to catch.
  return JSON.parse(JSON.stringify(live));
}

test("a genuine record re-derives to itself", async () => {
  const report = verifyResult(await record(), CURRENT);
  assert.equal(report.consistent, true);
  assert.equal(report.unverifiable, null);
  assert.deepEqual(report.missingIdentity, []);
  assert.deepEqual(report.configuration.drift, []);
  assert.deepEqual(report.passIntegrity, []);
  assert.deepEqual(report.validity.mismatches, []);
  assert.equal(report.derived.comparable, true);
  assert.deepEqual(report.derived.mismatches, []);
  // Vacuous success is the failure mode a check like this dies of: a verifier
  // that walks nothing reports no disagreements either.
  assert.ok(report.validity.checked >= 16, "every stored attempt must be rechecked");
  assert.equal(report.validity.checked, report.counts.attempts);
});

test("an inflated headline figure does not follow from the raw measurements", async () => {
  const tampered = await record();
  const real = tampered.derived.generationTokensPerSecond.median;
  tampered.derived.generationTokensPerSecond.median = 999.9;
  tampered.derived.roofline.utilization = 0.99;

  const report = verifyResult(tampered, CURRENT);
  assert.equal(report.consistent, false);
  const paths = report.derived.mismatches.map((entry) => entry.path);
  assert.deepEqual(paths.sort(), [
    "generationTokensPerSecond.median",
    "roofline.utilization",
  ]);
  assert.equal(
    report.derived.mismatches.find(
      (entry) => entry.path === "generationTokensPerSecond.median",
    ).recomputed,
    real,
  );
});

test("a flipped validity verdict is caught even though every figure still agrees", async () => {
  // deriveMetrics reads `valid` off the record rather than recomputing it, so
  // re-derivation alone would agree with a flipped verdict perfectly. This is
  // why validity is rechecked as its own layer.
  const tampered = await record();
  const pass = tampered.rawMeasurements.workloads.w4.measuredPasses[0];
  pass.attempts[0].measurement.eval_count = 7;
  pass.measurement.eval_count = 7;

  const report = verifyResult(tampered, CURRENT);
  assert.equal(report.consistent, false);
  assert.equal(report.validity.mismatches.length, 1);
  assert.deepEqual(report.validity.mismatches[0].reasons, ["eval-count-mismatch"]);
  assert.equal(report.validity.mismatches[0].recorded, true);
  assert.equal(report.validity.mismatches[0].recomputed, false);
});

test("a pass whose stored measurement drifts from its final attempt is caught", async () => {
  // Each pass stores the final attempt's measurement twice — once inside
  // attempts[], once at pass level. Derivation reads one copy and the §5.4
  // recheck reads the other, so editing exactly one of them is invisible to
  // either layer alone.
  const tampered = await record();
  tampered.rawMeasurements.workloads.w4.measuredPasses[0].attempts[0].measurement.eval_count = 7;

  const report = verifyResult(tampered, CURRENT);
  assert.equal(report.consistent, false);
  assert.equal(report.passIntegrity.length, 1);
  assert.match(report.passIntegrity[0].path, /^w4\.pass1\.measurement\.eval_count$/);
  assert.deepEqual(report.derived.mismatches, [], "the figures still agree — that is the point");
});

test("a configuration that does not match its own protocol version is caught", async () => {
  const tampered = await record();
  tampered.configuration.workloads.w2.promptTokenRange = { min: 1, max: 9999 };

  const report = verifyResult(tampered, CURRENT);
  assert.equal(report.consistent, false);
  assert.equal(report.configuration.checkable, true);
  assert.equal(report.configuration.drift.length, 1);
  assert.equal(
    report.configuration.drift[0].path,
    "configuration.workloads.w2.promptTokenRange",
  );
  assert.equal(report.configuration.drift[0].recorded, "1-9999");
  assert.equal(report.configuration.drift[0].recomputed, "20-64");
});

test("a record scored under different rules is not accused of disagreeing", async () => {
  // A scoring change recomputes history by design (§2). Reporting that as a
  // fault would train a reader to ignore the check, which costs more than the
  // check is worth.
  const older = await record();
  older.scoringVersion = "osai-bench-derive/1.4";

  const report = verifyResult(older, CURRENT);
  assert.equal(report.derived.comparable, false);
  assert.deepEqual(report.derived.mismatches, []);
  assert.equal(report.consistent, true);
  assert.match(
    renderVerifyReport(report, { path: "x.json" }),
    /not recomputed — the record was scored under different/,
  );
});

test("a record from another protocol version has its configuration left unjudged", async () => {
  const other = await record();
  other.protocolVersion = "osai-bench/2";

  const report = verifyResult(other, CURRENT);
  assert.equal(report.configuration.checkable, false);
  assert.deepEqual(report.configuration.drift, []);
});

test("a record with no raw measurements is unverifiable, not consistent", async () => {
  const stripped = await record();
  delete stripped.rawMeasurements;

  const report = verifyResult(stripped, CURRENT);
  assert.equal(report.consistent, false);
  assert.match(report.unverifiable, /no raw measurements/);
  assert.match(
    renderVerifyReport(report, { path: "x.json" }),
    /UNVERIFIABLE/,
  );
});

test("missing identity fields are named, not silently tolerated", async () => {
  const stripped = await record();
  delete stripped.model.digest;
  delete stripped.scoringVersion;

  const report = verifyResult(stripped, CURRENT);
  assert.equal(report.consistent, false);
  assert.deepEqual(report.missingIdentity.sort(), ["modelDigest", "scoringVersion"]);
});

test("the report never claims more than internal consistency", async () => {
  // The single most dangerous thing this feature could do is read as proof a
  // measurement happened. It is pinned here so it cannot be edited away
  // without a test failing and someone having to think about it.
  const text = renderVerifyReport(verifyResult(await record(), CURRENT), {
    path: "x.json",
  });
  assert.match(text, /CONSISTENT/);
  assert.match(text, /internal consistency, not authenticity/);
  assert.match(
    text,
    /No\s+client-side check can establish that a measurement really happened/,
  );
  // "verified" is the specific word a reader would carry away as a claim about
  // the measurement rather than about the arithmetic, so this output must not
  // use it at all.
  assert.doesNotMatch(text, /verified/i);
});
