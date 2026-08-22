const DURATION_FIELDS = [
  "total_duration",
  "load_duration",
  "prompt_eval_duration",
  "eval_duration",
];

// The prompt-shape rules, factored out of validatePass so the §4 precondition
// probe and the §5.4 per-pass check ask exactly the same question of exactly
// the same number. They are one rule at two moments: once about a prompt
// before anything is measured, once about a measurement after the fact.
//
// Kept as one function rather than two deliberately. A second implementation
// would eventually disagree with this one, and the failure modes of that
// disagreement are both bad: a run refused up front for a band it would have
// satisfied, or a run admitted to a band it cannot satisfy and left to
// discover that only after paying for the whole protocol.
export function checkPromptFit(promptTokens, workload) {
  const reasons = [];
  const promptTokensUsable =
    typeof promptTokens === "number" && Number.isFinite(promptTokens);

  // Truncation signature, applied to every workload.
  //
  // When a prompt exceeds num_ctx the runtime truncates it, and prompt_eval_count
  // comes back pinned at num_ctx. A rule that only compares the count against an
  // expected value cannot see this: if the expectation happens to equal num_ctx,
  // truncation lands exactly on it and the pass validates. Checking the count
  // against the context window itself is the only way to catch it.
  if (promptTokensUsable && promptTokens >= workload.numCtx) {
    reasons.push({
      code: "prompt-truncated",
      numCtx: workload.numCtx,
      actual: promptTokens,
      message:
        `prompt_eval_count (${promptTokens}) reached num_ctx (${workload.numCtx}); ` +
        "the prompt was truncated and the measurement is not comparable",
    });
  }

  // Band check. Deliberately a range rather than a target with a percentage
  // tolerance: token counts are model-dependent, and a percentage of a small
  // intended value collapses to a window narrower than one token of tokenizer
  // variation.
  if (workload.promptTokenRange !== null) {
    const { min, max } = workload.promptTokenRange;
    if (!promptTokensUsable || promptTokens < min || promptTokens > max) {
      reasons.push({
        code: "prompt-count-out-of-range",
        expectedMin: min,
        expectedMax: max,
        actual: promptTokensUsable ? promptTokens : null,
        message: `prompt_eval_count must fall between ${min} and ${max} tokens`,
      });
    }
  }

  return reasons;
}

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

  reasons.push(...checkPromptFit(measurement?.prompt_eval_count, workload));

  return { valid: reasons.length === 0, reasons };
}
