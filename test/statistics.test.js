import test from "node:test";
import assert from "node:assert/strict";
import {
  coefficientOfVariation,
  mean,
  median,
  sampleStandardDeviation,
} from "../src/derivation/statistics.js";

test("mean and median handle odd, even, empty, and unsorted inputs", () => {
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(mean([]), null);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.equal(median([]), null);
});

test("sample standard deviation and CV use the n-1 denominator", () => {
  assert.equal(sampleStandardDeviation([1, 2, 3, 4, 5]), Math.sqrt(2.5));
  assert.equal(
    coefficientOfVariation([1, 2, 3, 4, 5]),
    Math.sqrt(2.5) / 3,
  );
  assert.equal(sampleStandardDeviation([1]), null);
  assert.equal(coefficientOfVariation([]), null);
  assert.equal(coefficientOfVariation([0, 0]), null);
});

test("coefficient of variation is null, not zero, for a single sample", () => {
  // `sampleStandardDeviation` returns null below two values, and `null / mean`
  // coerces to 0 in JavaScript. A workload left with one surviving pass
  // therefore reported 0% run-to-run variation — perfect consistency — on
  // exactly the unstable machines the metric exists to identify.
  assert.equal(coefficientOfVariation([5]), null);
  assert.equal(coefficientOfVariation([]), null);
  assert.equal(sampleStandardDeviation([5]), null);
  assert.ok(coefficientOfVariation([4, 6]) > 0);
});
