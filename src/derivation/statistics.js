export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function sampleStandardDeviation(values) {
  const average = mean(values);
  if (average === null || values.length < 2) {
    return null;
  }
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

export function coefficientOfVariation(values) {
  const average = mean(values);
  if (average === null || average === 0) {
    return null;
  }
  const deviation = sampleStandardDeviation(values);
  // Explicit null guard, not incidental. `sampleStandardDeviation` returns null
  // for fewer than two values, and `null / average` coerces to 0 in JavaScript —
  // so a workload left with a single surviving pass previously reported 0%
  // run-to-run variation, i.e. perfect consistency, on exactly the unstable
  // machines this metric exists to identify.
  if (deviation === null) {
    return null;
  }
  return deviation / average;
}
