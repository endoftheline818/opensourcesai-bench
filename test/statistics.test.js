import test from "node:test";
import assert from "node:assert/strict";
import {
  coefficientOfVariation,
  mean,
  median,
  populationStandardDeviation,
} from "../src/derivation/statistics.js";

test("mean and median handle odd, even, empty, and unsorted inputs", () => {
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(mean([]), null);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.equal(median([]), null);
});

test("population standard deviation and CV use the full measured population", () => {
  assert.equal(populationStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(coefficientOfVariation([2, 4, 4, 4, 5, 5, 7, 9]), 0.4);
  assert.equal(coefficientOfVariation([]), null);
  assert.equal(coefficientOfVariation([0, 0]), null);
});
