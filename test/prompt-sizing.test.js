import test from "node:test";
import assert from "node:assert/strict";
import { LONG_PROMPT, SHORT_PROMPT, WORKLOADS } from "../src/protocol.js";
import { validatePass } from "../src/derivation/validity.js";

// These tests derive their expectations from the ACTUAL prompt constants rather
// than from fixtures.
//
// Every other test in this suite feeds the derivation layer fixture values that
// were written to match what the code expects — `prompt_eval_count: 32` for w2,
// `4096` for w3. Those satisfy any rule by construction, so the suite could
// prove the code self-consistent while the prompts it actually sends bore no
// relation to the counts being asserted. That is how a w3 prompt roughly twice
// the size of its own context window passed 62 green tests.
//
// Exact tokenization is model-dependent and cannot be computed without a
// tokenizer, so these tests bound it: they assert that across the whole
// plausible characters-per-token range, every prompt still satisfies its own
// workload's rules. A prompt that only works at one end of that range is a
// prompt waiting to fail on somebody else's model.

// English prose runs about 4 characters per token. Text dense in digits,
// newlines and punctuation tokenizes less efficiently, so the low end of this
// range is deliberately pessimistic — it produces the HIGHEST token estimate.
const CHARS_PER_TOKEN_MIN = 3.4;
const CHARS_PER_TOKEN_MAX = 4.6;

function tokenEstimateRange(text) {
  return {
    high: Math.ceil(text.length / CHARS_PER_TOKEN_MIN),
    low: Math.floor(text.length / CHARS_PER_TOKEN_MAX),
  };
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

test("every prompt fits strictly inside its own context window", () => {
  for (const workload of Object.values(WORKLOADS)) {
    const { high } = tokenEstimateRange(workload.prompt);
    assert.ok(
      high < workload.numCtx,
      `${workload.id}: prompt is ~${high} tokens at the pessimistic end but ` +
        `num_ctx is ${workload.numCtx}. The runtime would truncate it, and a ` +
        `truncated prompt cannot be compared against an untruncated one.`,
    );
  }
});

test("W3 keeps real headroom under num_ctx, not a margin of a few tokens", () => {
  const { high } = tokenEstimateRange(LONG_PROMPT);
  const headroom = (WORKLOADS.w3.numCtx - high) / WORKLOADS.w3.numCtx;
  assert.ok(
    headroom >= 0.1,
    `W3 leaves only ${(headroom * 100).toFixed(1)}% headroom under num_ctx. ` +
      "Token counts vary by model; a thin margin means truncation on the first " +
      "tokenizer that splits text less efficiently than assumed.",
  );
});

test("estimated prompt sizes satisfy their own workload's validity band", () => {
  for (const workload of Object.values(WORKLOADS)) {
    if (workload.promptTokenRange === null) continue;
    const { low, high } = tokenEstimateRange(workload.prompt);
    for (const [label, estimate] of [
      ["low", low],
      ["high", high],
    ]) {
      const result = passWith(estimate, workload);
      assert.equal(
        result.valid,
        true,
        `${workload.id}: a ${label} estimate of ${estimate} tokens fails its own ` +
          `band [${workload.promptTokenRange.min}, ${workload.promptTokenRange.max}] — ` +
          `reasons: ${result.reasons.map((r) => r.code).join(", ")}`,
      );
    }
  }
});

test("SHORT_PROMPT stays short enough to be interactively realistic", () => {
  // W2 measures time to first token as a user experiences it. A prompt that
  // drifted long would quietly turn a latency measurement into a prefill one.
  const { high } = tokenEstimateRange(SHORT_PROMPT);
  assert.ok(
    high <= 64,
    `SHORT_PROMPT is ~${high} tokens at the pessimistic end; W2 would no longer ` +
      "be measuring short-prompt latency.",
  );
});
