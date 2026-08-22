import { deriveMetrics } from "./metrics.js";
import { validatePass } from "./validity.js";

// Re-derives a stored result from its own raw measurements and reports every
// place the stored record disagrees with what its raw data implies.
//
// The protocol has always claimed that raw measurements are immutable and
// authoritative and that every derived figure is recomputable from them (§2).
// Nothing let anyone check it. A result could be edited by hand -- or corrupted
// in transit, or produced by a build that no longer matches its own version
// string -- and the record would still parse, still validate against the
// schema, and still read as a clean run. This turns that claim from a property
// of the design into something a reader can run.
//
// WHAT THIS ESTABLISHES: internal consistency. The stored figures follow from
// the stored measurements under the stated rules, the stored per-attempt
// validity verdicts are the ones §5.4 actually returns for those measurements,
// and the configuration the run recorded is the configuration its protocol
// version defines.
//
// WHAT IT DOES NOT ESTABLISH, and must never be described as establishing:
// that the raw measurements are real. A record whose numbers were invented and
// then made self-consistent passes every check here, because every check here
// is computable by whoever invented them. Authenticity is not a property a
// self-produced artifact can carry, and no amount of client-side hashing
// changes that -- see spec/result-integrity-v1.md.

const DERIVED_NUMERIC_PATHS = Object.freeze([
  "generationTokensPerSecond",
  "prefillTokensPerSecond",
  "timeToFirstTokenMs",
  "timeToFirstVisibleTokenMs",
  "coldLoad",
  "passFailureRate",
  "attemptFailureRate",
  "roofline",
]);

function difference(path, recorded, recomputed) {
  return { path, recorded: recorded ?? null, recomputed: recomputed ?? null };
}

// Deep comparison that reports the first divergence per leaf rather than
// asserting equality, because "which figure disagrees" is the useful output
// and "they differ" is not.
function compare(path, recorded, recomputed, differences) {
  if (Array.isArray(recomputed) || Array.isArray(recorded)) {
    const left = Array.isArray(recorded) ? recorded : [];
    const right = Array.isArray(recomputed) ? recomputed : [];
    if (left.length !== right.length) {
      differences.push(difference(`${path}.length`, left.length, right.length));
      return;
    }
    for (let index = 0; index < right.length; index += 1) {
      compare(`${path}[${index}]`, left[index], right[index], differences);
    }
    return;
  }
  if (recomputed !== null && typeof recomputed === "object") {
    const source = recorded !== null && typeof recorded === "object" ? recorded : {};
    for (const key of Object.keys(recomputed)) {
      compare(`${path}.${key}`, source[key], recomputed[key], differences);
    }
    return;
  }
  // Recomputation is deterministic: the same pure functions over the same
  // stored numbers produce bit-identical results, so exact equality is the
  // right comparison and a tolerance would only hide a real disagreement.
  if (!Object.is(recorded ?? null, recomputed ?? null)) {
    differences.push(difference(path, recorded, recomputed));
  }
}

// The workload definition as the RECORD says the run used it, shaped for
// validatePass. Validity is rechecked against what the run recorded rather
// than against this client's current constants, because that is the rule the
// run was actually judged by; whether those recorded values are the right ones
// for the record's protocol version is a separate question, asked below.
function recordedWorkload(id, configuration) {
  const workload = configuration?.workloads?.[id];
  if (!workload) return null;
  return {
    id,
    numPredict: workload.numPredict,
    numCtx: workload.numCtx,
    promptTokenRange: workload.promptTokenRange ?? null,
  };
}

function checkConfiguration(record, workloads, protocolVersion) {
  const drift = [];
  if (record.protocolVersion !== protocolVersion) {
    // A record from a different protocol version is not drifted, it is a
    // different contract. Conformance is simply not checkable here.
    return { checkable: false, drift };
  }
  for (const [id, expected] of Object.entries(workloads)) {
    const recorded = record.configuration?.workloads?.[id];
    if (!recorded) {
      drift.push(difference(`configuration.workloads.${id}`, null, "defined"));
      continue;
    }
    for (const field of ["numPredict", "numCtx", "warmups", "repetitions"]) {
      if (recorded[field] !== expected[field]) {
        drift.push(
          difference(
            `configuration.workloads.${id}.${field}`,
            recorded[field],
            expected[field],
          ),
        );
      }
    }
    const expectedRange = expected.promptTokenRange ?? null;
    const recordedRange = recorded.promptTokenRange ?? null;
    if (
      (expectedRange === null) !== (recordedRange === null) ||
      (expectedRange !== null &&
        (recordedRange.min !== expectedRange.min ||
          recordedRange.max !== expectedRange.max))
    ) {
      drift.push(
        difference(
          `configuration.workloads.${id}.promptTokenRange`,
          recordedRange ? `${recordedRange.min}-${recordedRange.max}` : null,
          expectedRange ? `${expectedRange.min}-${expectedRange.max}` : null,
        ),
      );
    }
  }
  return { checkable: true, drift };
}

export function verifyResult(record, { workloads, protocolVersion, scoringVersion }) {
  const identity = {
    protocolVersion: record?.protocolVersion ?? null,
    scoringVersion: record?.scoringVersion ?? null,
    clientVersion: record?.clientVersion ?? null,
    runtime: record?.runtime?.version ?? null,
    model: record?.model?.identifier ?? null,
    modelDigest: record?.model?.digest ?? null,
    createdAt: record?.createdAt ?? null,
    cohortEligible: record?.cohortEligible ?? null,
    qualityOverride: record?.qualityOverride ?? null,
  };

  const missingIdentity = Object.entries({
    protocolVersion: identity.protocolVersion,
    scoringVersion: identity.scoringVersion,
    clientVersion: identity.clientVersion,
    createdAt: identity.createdAt,
    modelDigest: identity.modelDigest,
  })
    .filter(([, value]) => value === null || value === undefined)
    .map(([field]) => field);

  if (!record?.rawMeasurements?.workloads) {
    return {
      identity,
      missingIdentity,
      configuration: { checkable: false, drift: [] },
      validity: { checked: 0, mismatches: [] },
      passIntegrity: [],
      derived: { comparable: false, mismatches: [] },
      counts: { passes: 0, attempts: 0 },
      consistent: false,
      unverifiable: "the record carries no raw measurements to re-derive from",
    };
  }

  const configuration = checkConfiguration(record, workloads, protocolVersion);

  // Layer one: every stored validity verdict, recomputed. deriveMetrics reads
  // `valid` off the record rather than recomputing it, so without this a
  // flipped verdict would propagate into every derived figure and the
  // recomputation below would agree with it perfectly.
  const validityMismatches = [];
  const passIntegrity = [];
  let checkedAttempts = 0;
  let passes = 0;
  let attempts = 0;
  for (const [id, workload] of Object.entries(record.rawMeasurements.workloads)) {
    const definition = recordedWorkload(id, record.configuration);
    for (const pass of workload.measuredPasses ?? []) {
      passes += 1;
      // A pass stores the final attempt's measurement and verdict twice: once
      // inside attempts[], once at pass level. Derivation reads the pass-level
      // copy while §5.4's recheck reads the attempt-level one, so editing
      // exactly one of them is invisible to either check alone. They are the
      // same numbers by construction and must stay so.
      const finalAttempt = (pass.attempts ?? []).at(-1);
      if (finalAttempt) {
        compare(
          `${id}.pass${pass.index ?? "?"}.measurement`,
          pass.measurement,
          finalAttempt.measurement,
          passIntegrity,
        );
        if ((pass.valid ?? null) !== (finalAttempt.validity?.valid ?? null)) {
          passIntegrity.push(
            difference(
              `${id}.pass${pass.index ?? "?"}.valid`,
              pass.valid ?? null,
              finalAttempt.validity?.valid ?? null,
            ),
          );
        }
      }
      for (const [index, attempt] of (pass.attempts ?? []).entries()) {
        attempts += 1;
        if (!definition) continue;
        checkedAttempts += 1;
        const recomputed = validatePass(attempt.measurement, definition);
        const recordedValid = attempt.validity?.valid ?? null;
        if (recomputed.valid !== recordedValid) {
          validityMismatches.push({
            workload: id,
            pass: pass.index ?? null,
            attempt: index + 1,
            recorded: recordedValid,
            recomputed: recomputed.valid,
            reasons: recomputed.reasons.map((reason) => reason.code),
          });
        }
      }
    }
  }

  // Layer two: every derived figure, recomputed. Only meaningful against a
  // record produced under the same scoring rules -- a scoring change
  // recomputes history by design (§2), so a difference across versions is the
  // system working rather than a fault, and reporting it as one would train a
  // reader to ignore the check.
  const derivedComparable =
    record.scoringVersion === scoringVersion && record.derived != null;
  const derivedMismatches = [];
  if (derivedComparable) {
    const recomputed = deriveMetrics(record);
    for (const path of DERIVED_NUMERIC_PATHS) {
      compare(path, record.derived[path], recomputed[path], derivedMismatches);
    }
    compare(
      "diagnostics",
      record.derived.diagnostics,
      recomputed.diagnostics,
      derivedMismatches,
    );
  }

  return {
    identity,
    missingIdentity,
    configuration,
    validity: { checked: checkedAttempts, mismatches: validityMismatches },
    passIntegrity,
    derived: { comparable: derivedComparable, mismatches: derivedMismatches },
    counts: { passes, attempts },
    consistent:
      missingIdentity.length === 0 &&
      configuration.drift.length === 0 &&
      passIntegrity.length === 0 &&
      validityMismatches.length === 0 &&
      derivedMismatches.length === 0,
    unverifiable: null,
  };
}
