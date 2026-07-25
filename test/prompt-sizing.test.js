import test from "node:test";
import assert from "node:assert/strict";
import { LONG_PROMPT, SHORT_PROMPT, WORKLOADS } from "../src/protocol.js";
import { validatePass } from "../src/derivation/validity.js";

// Prompt sizing checked against MEASURED tokenization, not character estimates.
//
// Two rounds of this went wrong in opposite directions, which is the whole
// reason this file is written the way it is:
//
//   1. v1.1 sized W3 at "~4096 tokens" and shipped ~7,500-8,300. The runtime
//      truncated to num_ctx, and because validity compared the count against an
//      intended 4,096, the truncated value matched and every pass validated.
//   2. The correction used a character estimate of 3.4-4.6 chars/token and
//      produced 1,770 actual tokens against a 2,000 floor — every W3 pass
//      failed. The real ratio is 6.73.
//
// Character-based token estimation carries roughly a 2x spread and is unusable
// for sizing near a boundary. So these tests anchor on ratios actually measured
// with scripts/diagnose-prompts.js, and treat a change in prompt length as a
// reason to re-measure rather than re-derive.

// Measured on llama3.1:8b (Ollama 0.32.3) via scripts/diagnose-prompts.js.
// Re-measure after ANY prompt edit; do not adjust these by reasoning.
const MEASURED = {
  short: { chars: 153, tokens: 45 },
  longPerRepetition: { chars: 11910 / 80, tokens: 1770 / 80 },
};

const SHORT_RATIO = MEASURED.short.chars / MEASURED.short.tokens; // ~3.40
const LONG_RATIO =
  MEASURED.longPerRepetition.chars / MEASURED.longPerRepetition.tokens; // ~6.73

// Tokenizers differ between model families, so allow a margin around the
// measured ratio rather than treating one model as universal. +/-25% is wide
// enough to cover llama/qwen/mistral variation and still narrow enough to catch
// a prompt that has drifted materially.
const RATIO_MARGIN = 0.25;

function tokenRange(chars, measuredRatio) {
  return {
    // A more efficient tokenizer yields FEWER tokens: tests the band floor.
    low: Math.floor(chars / (measuredRatio * (1 + RATIO_MARGIN))),
    // A less efficient tokenizer yields MORE tokens: tests the num_ctx ceiling.
    high: Math.ceil(chars / (measuredRatio * (1 - RATIO_MARGIN))),
  };
}

function ratioFor(workload) {
  return workload.prompt === LONG_PROMPT ? LONG_RATIO : SHORT_RATIO;
}

function passWith(promptTokens, workload) {
  return validatePass(
    {
      total_duration: 10,
      load_duration: 1,
      prompt_eval_count: promptTokens,
      prompt_eval_duration: 2,
      eval_count: workload.numPredict,
      eval_duration: 7,
      timeToFirstTokenMs: 4,
    },
    workload,
  );
}

test("measured ratios still describe the current prompts", () => {
  // Drift detector. If a prompt is edited, its character count moves and the
  // stored ratio no longer applies — re-run scripts/diagnose-prompts.js and
  // update MEASURED rather than nudging the numbers until this passes.
  assert.equal(
    SHORT_PROMPT.length,
    MEASURED.short.chars,
    "SHORT_PROMPT changed since it was last measured — re-measure it",
  );
  const perRepetition = LONG_PROMPT.length / WORKLOADS.w3.prompt.split("\n").length;
  assert.ok(
    Math.abs(perRepetition - MEASURED.longPerRepetition.chars) < 2,
    `LONG_PROMPT's per-repetition length is ${perRepetition.toFixed(1)} chars but ` +
      `${MEASURED.longPerRepetition.chars.toFixed(1)} was measured — re-measure it`,
  );
});

test("every prompt fits strictly inside its own context window", () => {
  for (const workload of Object.values(WORKLOADS)) {
    const { high } = tokenRange(workload.prompt.length, ratioFor(workload));
    assert.ok(
      high < workload.numCtx,
      `${workload.id}: ~${high} tokens against num_ctx ${workload.numCtx} on a ` +
        "less efficient tokenizer. The runtime would truncate, and a truncated " +
        "prompt is not comparable with an untruncated one.",
    );
  }
});

test("W3 clears its saturation floor even on an efficient tokenizer", () => {
  // This is the check that was missing. The previous version asserted the
  // *pessimistic* estimate cleared the floor, which is the wrong direction — a
  // more efficient tokenizer produces fewer tokens, and that is exactly how
  // 1,770 got through a check intended to guarantee at least 2,000.
  const { low } = tokenRange(LONG_PROMPT.length, LONG_RATIO);
  assert.ok(
    low >= WORKLOADS.w3.promptTokenRange.min,
    `W3 yields ~${low} tokens on an efficient tokenizer but its floor is ` +
      `${WORKLOADS.w3.promptTokenRange.min}. Prefill would fail every pass.`,
  );
});

test("W3 keeps real headroom under num_ctx", () => {
  const { high } = tokenRange(LONG_PROMPT.length, LONG_RATIO);
  const headroom = (WORKLOADS.w3.numCtx - high) / WORKLOADS.w3.numCtx;
  assert.ok(
    headroom >= 0.1,
    `W3 leaves only ${(headroom * 100).toFixed(1)}% headroom under num_ctx.`,
  );
});

test("both ends of each prompt's range satisfy its own validity band", () => {
  for (const workload of Object.values(WORKLOADS)) {
    if (workload.promptTokenRange === null) continue;
    const { low, high } = tokenRange(workload.prompt.length, ratioFor(workload));
    for (const [label, estimate] of [
      ["efficient", low],
      ["inefficient", high],
    ]) {
      const result = passWith(estimate, workload);
      assert.equal(
        result.valid,
        true,
        `${workload.id}: an ${label} tokenizer yields ~${estimate} tokens, which ` +
          `fails its band [${workload.promptTokenRange.min}, ${workload.promptTokenRange.max}] — ` +
          `${result.reasons.map((r) => r.code).join(", ")}`,
      );
    }
  }
});

test("the measured short-prompt count sits inside the W2/W4 band", () => {
  // 45 tokens measured, band 20-64. Recorded as a regression anchor: the band
  // was set from an estimate of 33-42 and the real value landed outside it,
  // which held only because the band was generous.
  for (const workload of [WORKLOADS.w2, WORKLOADS.w4]) {
    assert.equal(passWith(MEASURED.short.tokens, workload).valid, true);
  }
});
