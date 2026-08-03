import { coefficientOfVariation, median } from "./statistics.js";
import { deriveDiagnostics } from "./diagnostics.js";

const NANOSECONDS_PER_SECOND = 1e9;

export function generationTokensPerSecond(measurement) {
  return measurement.eval_count / (measurement.eval_duration / NANOSECONDS_PER_SECOND);
}

export function prefillTokensPerSecond(measurement) {
  return (
    measurement.prompt_eval_count /
    (measurement.prompt_eval_duration / NANOSECONDS_PER_SECOND)
  );
}

export function coldLoadSeconds(measurement) {
  return measurement.load_duration / NANOSECONDS_PER_SECOND;
}

function successfulMeasurements(workload) {
  if (!workload || workload.failed) {
    return [];
  }
  return workload.measuredPasses.map((pass) => pass.measurement);
}

function metricSummary(values) {
  return {
    median: median(values),
    coefficientOfVariation: coefficientOfVariation(values),
    samples: values.length,
  };
}

// mean()/median() (statistics.js) coerce `null` to 0 during arithmetic
// (`sum + null === sum` in JavaScript), so a workload with even one
// legitimately-null TTFT would silently corrupt its own median/CV rather
// than exclude that pass. This was invisible until now because every prior
// case of a null TTFT was ALSO the only measured pass with any data at all
// for that run (never a mix of null and real values within the same set of
// five), so "corrupt the mean toward zero" and "exclude and report fewer
// samples" happened to produce the same median by coincidence. A thinking
// model whose reasoning outlasts the whole W2 budget makes all five nulls at
// once (still coincidentally safe); nothing yet has produced a PARTIAL set,
// but nothing rules it out either, so this is fixed as a real defect, not
// speculative hardening. Filtering here rather than making mean/median
// null-aware is deliberate: those functions are shared by metrics that have
// no null concept at all (throughput, cold load), so changing their
// contract would affect every caller, not just this one.
function deriveTimeToFirstToken(w2Measurements) {
  const reasoningWithheldPasses = w2Measurements.filter(
    (measurement) =>
      measurement.timeToFirstTokenMs === null &&
      Number.isFinite(measurement.eval_count) &&
      measurement.eval_count > 0,
  ).length;
  const values = w2Measurements
    .map((measurement) => measurement.timeToFirstTokenMs)
    .filter((value) => value !== null);
  return {
    ...metricSummary(values),
    // A pass where generation genuinely happened (eval_count > 0) but no
    // chunk in either channel was ever streamed -- Ollama withheld an
    // entire reasoning phase because the workload's num_predict budget was
    // exhausted before the model exited it, not a measurement failure. See
    // the adapter's streamedChunkHasToken comment and lab run 9
    // (2026-08-03, gemma4:31b) for the case that surfaced this.
    reasoningWithheldPasses,
  };
}

export function deriveMetrics(record) {
  const w1 = successfulMeasurements(record.rawMeasurements.workloads.w1);
  const w2 = successfulMeasurements(record.rawMeasurements.workloads.w2);
  const w3 = successfulMeasurements(record.rawMeasurements.workloads.w3);
  const w4 = successfulMeasurements(record.rawMeasurements.workloads.w4);

  const generationValues = w4.map(generationTokensPerSecond);
  const prefillValues = w3.map(prefillTokensPerSecond);
  const coldValues = w1.map(coldLoadSeconds);

  const generation = metricSummary(generationValues);
  const prefill = metricSummary(prefillValues);
  const timeToFirstToken = deriveTimeToFirstToken(w2);
  // First VISIBLE token, deliberately from W4 rather than W2: W2's small
  // 128-token budget is exactly the case most likely to be entirely consumed
  // by reasoning (see reasoningWithheldPasses above), which would make this
  // stat null for precisely the runs where it matters most. W4's 512-token
  // budget is what actually captured a real value in the case this exists
  // to cover -- gemma4:31b exited reasoning and produced a visible token
  // partway through W4 in every one of lab run 9's five measured passes,
  // while every one of its W2 passes stayed inside reasoning the whole time.
  const timeToFirstVisibleTokenMs = metricSummary(
    w4
      .map((measurement) => measurement.timeToFirstVisibleTokenMs)
      .filter((value) => value !== null && value !== undefined),
  );
  const coldLoad = {
    seconds: coldValues.length === 1 ? coldValues[0] : null,
    samples: coldValues.length,
  };

  const measuredPasses = Object.values(record.rawMeasurements.workloads).flatMap(
    (workload) => workload.measuredPasses,
  );
  const failedMeasuredPasses = measuredPasses.filter((pass) => !pass.valid).length;
  const passFailureRate = {
    failedMeasuredPasses,
    totalMeasuredPasses: measuredPasses.length,
    percent:
      measuredPasses.length > 0
        ? (failedMeasuredPasses / measuredPasses.length) * 100
        : null,
  };
  const measuredAttempts = measuredPasses.flatMap((pass) => pass.attempts);
  const failedAttempts = measuredAttempts.filter(
    (attempt) => !attempt.validity.valid,
  ).length;
  const attemptFailureRate = {
    failedAttempts,
    totalAttempts: measuredAttempts.length,
    percent:
      measuredAttempts.length > 0
        ? (failedAttempts / measuredAttempts.length) * 100
        : null,
  };

  const bandwidth = record.configuration.memoryBandwidthGBps;
  const weightGB =
    Number.isFinite(record.model.weightsBytes) && record.model.weightsBytes > 0
      ? record.model.weightsBytes / 1e9
      : null;
  const theoreticalMaxTokensPerSecond =
    Number.isFinite(bandwidth) && bandwidth > 0 && weightGB
      ? bandwidth / weightGB
      : null;
  const rooflineUtilization =
    theoreticalMaxTokensPerSecond && generation.median !== null
      ? generation.median / theoreticalMaxTokensPerSecond
      : null;

  return {
    generationTokensPerSecond: generation,
    prefillTokensPerSecond: prefill,
    timeToFirstTokenMs: timeToFirstToken,
    timeToFirstVisibleTokenMs,
    coldLoad,
    passFailureRate,
    attemptFailureRate,
    roofline: {
      modelWeightsGB: weightGB,
      memoryBandwidthGBps: bandwidth ?? null,
      theoreticalMaxTokensPerSecond,
      utilization: rooflineUtilization,
    },
    diagnostics: deriveDiagnostics(record),
  };
}
