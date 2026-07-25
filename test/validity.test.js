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
    prompt_eval_count: 4096,
    eval_count: 0,
  };
  assert.equal(validatePass(w1, WORKLOADS.w1).valid, true);
  assert.equal(validatePass(w3, WORKLOADS.w3).valid, true);
});

test("prompt token deviation permits 5% and rejects more than 5%", () => {
  assert.equal(
    validatePass({ ...valid, prompt_eval_count: 31 }, WORKLOADS.w2).valid,
    true,
  );
  assert.equal(
    validatePass({ ...valid, prompt_eval_count: 30 }, WORKLOADS.w2).valid,
    false,
  );
  assert.equal(
    validatePass(
      { ...valid, prompt_eval_count: 3892, eval_count: 1 },
      WORKLOADS.w3,
    ).valid,
    true,
  );
  assert.equal(
    validatePass(
      { ...valid, prompt_eval_count: 3891, eval_count: 1 },
      WORKLOADS.w3,
    ).valid,
    false,
  );
});
