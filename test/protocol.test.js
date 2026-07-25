import test from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_OPTIONS,
  MAX_RETRIES,
  PROTOCOL_VERSION,
  REPETITIONS,
  SCORING_VERSION,
  WORKLOADS,
} from "../src/protocol.js";

test("protocol constants preserve fixed options, workload order, and pass counts", () => {
  assert.equal(PROTOCOL_VERSION, "osai-bench/1.1");
  assert.equal(SCORING_VERSION, "osai-bench-derive/1.2");
  assert.deepEqual(FIXED_OPTIONS, { temperature: 0, seed: 42 });
  assert.deepEqual(Object.keys(WORKLOADS), ["w1", "w2", "w3", "w4"]);
  assert.equal(REPETITIONS, 5);
  assert.equal(MAX_RETRIES, 2);
  assert.equal(WORKLOADS.w1.repetitions, 1);
  for (const id of ["w2", "w3", "w4"]) {
    assert.equal(WORKLOADS[id].warmups, 1);
    assert.equal(WORKLOADS[id].repetitions, 5);
    assert.equal(WORKLOADS[id].keepAlive, "5m");
  }
  assert.equal(WORKLOADS.w2.numPredict, 128);
  assert.equal(WORKLOADS.w3.numPredict, 1);
  assert.equal(WORKLOADS.w4.numPredict, 512);
});
