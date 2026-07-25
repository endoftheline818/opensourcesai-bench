import test from "node:test";
import assert from "node:assert/strict";
import { validatePass } from "../src/derivation/validity.js";
import { WORKLOADS } from "../src/protocol.js";

const valid = {
  total_duration: 10,
  load_duration: 1,
  prompt_eval_count: 32,
  prompt_eval_duration: 2,
  eval_count: 128,
  eval_duration: 7,
  timeToFirstTokenMs: 4,
};

test("valid W2 pass succeeds", () => {
  assert.deepEqual(validatePass(valid, WORKLOADS.w2), {
    valid: true,
    reasons: [],
  });
});

for (const field of [
  "total_duration",
  "load_duration",
  "prompt_eval_duration",
  "eval_duration",
]) {
  test(`missing or zero ${field} invalidates a pass`, () => {
    const absent = { ...valid };
    delete absent[field];
    assert.equal(validatePass(absent, WORKLOADS.w2).valid, false);
    assert.equal(
      validatePass({ ...valid, [field]: 0 }, WORKLOADS.w2).valid,
      false,
    );
  });
}

test("W2 and W4 require eval_count to equal num_predict", () => {
  assert.ok(
    validatePass({ ...valid, eval_count: 127 }, WORKLOADS.w2).reasons.some(
      (reason) => reason.code === "eval-count-mismatch",
    ),
  );
  assert.ok(
    validatePass(
      { ...valid, eval_count: 511 },
      WORKLOADS.w4,
    ).reasons.some((reason) => reason.code === "eval-count-mismatch"),
  );
});

test("W1 and W3 do not apply the W2/W4 eval-count rule", () => {
  const w1 = { ...valid, eval_count: 0, prompt_eval_count: 5 };
  const w3 = {
    ...valid,
    prompt_eval_count: 3100,
    eval_count: 0,
  };
  assert.equal(validatePass(w1, WORKLOADS.w1).valid, true);
  assert.equal(validatePass(w3, WORKLOADS.w3).valid, true);
});

test("prompt token band accepts tokenizer variation and rejects the extremes", () => {
  // The band exists because a percentage tolerance around a small target
  // collapses below one token of tokenizer variation. Every count a real model
  // plausibly produces for SHORT_PROMPT must validate.
  for (const count of [33, 36, 38, 42]) {
    assert.equal(
      validatePass({ ...valid, prompt_eval_count: count }, WORKLOADS.w2).valid,
      true,
      `expected ${count} tokens to be accepted for w2`,
    );
  }
  assert.equal(
    validatePass({ ...valid, prompt_eval_count: 19 }, WORKLOADS.w2).valid,
    false,
  );
  assert.equal(
    validatePass({ ...valid, prompt_eval_count: 65 }, WORKLOADS.w2).valid,
    false,
  );
});

test("W3 rejects a prompt that never reached the saturation floor", () => {
  const shortPrefill = validatePass(
    { ...valid, prompt_eval_count: 1999, eval_count: 1 },
    WORKLOADS.w3,
  );
  assert.equal(shortPrefill.valid, false);
  assert.ok(
    shortPrefill.reasons.some(
      (reason) => reason.code === "prompt-count-out-of-range",
    ),
  );
});

test("prompt_eval_count reaching num_ctx is treated as truncation", () => {
  // The defect this guards: a prompt longer than num_ctx gets truncated, and
  // prompt_eval_count comes back pinned at num_ctx. Under the previous
  // expected-value rule — where the expectation for W3 *was* 4096 — truncation
  // landed exactly on the expectation and the pass validated, so W3 reported
  // clean measurements of a prompt it never actually processed in full.
  const truncated = validatePass(
    { ...valid, prompt_eval_count: 4096, eval_count: 1 },
    WORKLOADS.w3,
  );
  assert.equal(truncated.valid, false);
  assert.ok(
    truncated.reasons.some((reason) => reason.code === "prompt-truncated"),
    "truncation at num_ctx must be reported explicitly",
  );

  // Applies to every workload, including those with no band of their own.
  const w1Truncated = validatePass(
    { ...valid, prompt_eval_count: WORKLOADS.w1.numCtx, eval_count: 0 },
    WORKLOADS.w1,
  );
  assert.equal(w1Truncated.valid, false);
  assert.ok(
    w1Truncated.reasons.some((reason) => reason.code === "prompt-truncated"),
  );
});
