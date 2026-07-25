const DURATION_FIELDS = [
  "total_duration",
  "load_duration",
  "prompt_eval_duration",
  "eval_duration",
];

export function validatePass(measurement, workload) {
  const reasons = [];

  for (const field of DURATION_FIELDS) {
    if (
      typeof measurement?.[field] !== "number" ||
      !Number.isFinite(measurement[field]) ||
      measurement[field] <= 0
    ) {
      reasons.push({
        code: "missing-or-zero-duration",
        field,
        message: `${field} must be present and greater than zero`,
      });
    }
  }

  if (
    (workload.id === "w2" || workload.id === "w4") &&
    measurement?.eval_count !== workload.numPredict
  ) {
    reasons.push({
      code: "eval-count-mismatch",
      expected: workload.numPredict,
      actual: measurement?.eval_count ?? null,
      message: `eval_count must equal num_predict (${workload.numPredict})`,
    });
  }

  if (workload.intendedPromptTokens !== null) {
    const actual = measurement?.prompt_eval_count;
    const allowedDeviation = workload.intendedPromptTokens * 0.05;
    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      Math.abs(actual - workload.intendedPromptTokens) > allowedDeviation
    ) {
      reasons.push({
        code: "prompt-count-deviation",
        expected: workload.intendedPromptTokens,
        tolerancePercent: 5,
        actual: actual ?? null,
        message: "prompt_eval_count deviates from the intended length by more than 5%",
      });
    }
  }

  return { valid: reasons.length === 0, reasons };
}
