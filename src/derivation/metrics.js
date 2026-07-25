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

export function deriveMetrics(record) {
  const w1 = successfulMeasurements(record.rawMeasurements.workloads.w1);
  const w2 = successfulMeasurements(record.rawMeasurements.workloads.w2);
  const w3 = successfulMeasurements(record.rawMeasurements.workloads.w3);
  const w4 = successfulMeasurements(record.rawMeasurements.workloads.w4);

  const generationValues = w4.map(generationTokensPerSecond);
  const prefillValues = w3.map(prefillTokensPerSecond);
  const ttftValues = w2.map((measurement) => measurement.timeToFirstTokenMs);
  const coldValues = w1.map(coldLoadSeconds);

  const generation = metricSummary(generationValues);
  const prefill = metricSummary(prefillValues);
  const timeToFirstToken = metricSummary(ttftValues);
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
