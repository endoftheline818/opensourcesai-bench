import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareRuntimeEnvironments,
  deriveRuntimeEnvironment,
  OLLAMA_ENVIRONMENT_VARIABLES,
} from "../src/derivation/environment.js";
import { runBenchmark } from "../src/benchmark.js";
import { renderReport } from "../src/output/report.js";
import { FixtureAdapter, loadFixture, normalRecord } from "./helpers.js";
import { deriveMetrics } from "../src/derivation/metrics.js";

// The two real capture boxes as observed on 2026-07-26.
const RTX_4070_TI = {
  OLLAMA_KV_CACHE_TYPE: "q8_0",
  OLLAMA_FLASH_ATTENTION: "true",
  OLLAMA_HOST: "0.0.0.0",
};
const RTX_3080_RIG = {
  OLLAMA_HOST: "0.0.0.0:11434",
  OLLAMA_KEEP_ALIVE: "24h",
};

test("only allowlisted variables are recorded", () => {
  const environment = deriveRuntimeEnvironment({
    OLLAMA_KV_CACHE_TYPE: "q8_0",
    AWS_SECRET_ACCESS_KEY: "should-never-appear",
    HOME: "/home/cj",
    PATH: "/usr/bin",
  });
  const recorded = Object.keys(environment.declared);
  assert.deepEqual(
    recorded.sort(),
    OLLAMA_ENVIRONMENT_VARIABLES.map((v) => v.name).sort(),
  );
  const serialized = JSON.stringify(environment);
  assert.ok(!serialized.includes("should-never-appear"));
  assert.ok(!serialized.includes("/home/cj"));
});

test("path-like and address-like variables record presence, never their value", () => {
  const environment = deriveRuntimeEnvironment({
    OLLAMA_MODELS: "C:\\Users\\somebody\\.ollama\\models",
    OLLAMA_HOST: "192.168.1.50:11434",
  });
  assert.equal(environment.declared.OLLAMA_MODELS, true);
  assert.equal(environment.declared.OLLAMA_HOST, true);
  const serialized = JSON.stringify(environment);
  assert.ok(!serialized.includes("somebody"));
  assert.ok(!serialized.includes("192.168.1.50"));
});

test("an unset variable is null and an empty variable counts as unset", () => {
  const environment = deriveRuntimeEnvironment({
    OLLAMA_KV_CACHE_TYPE: "   ",
  });
  assert.equal(environment.declared.OLLAMA_KV_CACHE_TYPE, null);
  assert.equal(environment.declared.OLLAMA_FLASH_ATTENTION, null);
  assert.deepEqual(environment.declaredNonDefault, []);
});

test("the declaration is never marked authoritative", () => {
  const environment = deriveRuntimeEnvironment(RTX_4070_TI);
  assert.equal(environment.authoritative, false);
  assert.equal(environment.source, "client-process-env");
  assert.match(environment.note, /server may have been started with a different/);
});

test("the real 4070 Ti and 3080 rig environments are reported incomparable", () => {
  const result = compareRuntimeEnvironments(
    deriveRuntimeEnvironment(RTX_4070_TI),
    deriveRuntimeEnvironment(RTX_3080_RIG),
  );
  assert.equal(result.verdict, "incomparable");
  assert.equal(result.comparable, false);
  const blocking = result.differences
    .filter((entry) => entry.comparability === "blocking")
    .map((entry) => entry.variable);
  assert.ok(blocking.includes("OLLAMA_KV_CACHE_TYPE"));
  assert.ok(blocking.includes("OLLAMA_FLASH_ATTENTION"));
  assert.match(result.message, /must not be compared or pooled/);
});

test("a missing environment is unknown, never comparable", () => {
  const present = deriveRuntimeEnvironment(RTX_4070_TI);
  for (const absent of [null, undefined, {}, { declared: null }]) {
    const result = compareRuntimeEnvironments(present, absent);
    assert.equal(result.verdict, "unknown");
    assert.equal(result.comparable, false);
  }
  // Symmetric: order must not change the verdict.
  assert.equal(
    compareRuntimeEnvironments(null, present).verdict,
    "unknown",
  );
});

test("identical declarations are comparable but only presumed so", () => {
  const result = compareRuntimeEnvironments(
    deriveRuntimeEnvironment(RTX_4070_TI),
    deriveRuntimeEnvironment({ ...RTX_4070_TI }),
  );
  assert.equal(result.verdict, "comparable");
  assert.equal(result.comparable, true);
  assert.deepEqual(result.differences, []);
  assert.match(result.message, /presumed, not proven/);
});

test("an advisory-only difference stays comparable", () => {
  const result = compareRuntimeEnvironments(
    deriveRuntimeEnvironment({ OLLAMA_KEEP_ALIVE: "5m" }),
    deriveRuntimeEnvironment({ OLLAMA_KEEP_ALIVE: "24h" }),
  );
  assert.equal(result.verdict, "advisory");
  assert.equal(result.comparable, true);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].variable, "OLLAMA_KEEP_ALIVE");
});

test("every blocking variable difference alone forces incomparable", () => {
  const blocking = OLLAMA_ENVIRONMENT_VARIABLES.filter(
    (variable) => variable.comparability === "blocking",
  );
  assert.ok(blocking.length > 0);
  for (const variable of blocking) {
    const result = compareRuntimeEnvironments(
      deriveRuntimeEnvironment({}),
      deriveRuntimeEnvironment({ [variable.name]: "some-value" }),
    );
    assert.equal(
      result.verdict,
      "incomparable",
      `${variable.name} differing should make runs incomparable`,
    );
  }
});

test("a completed run records the declared environment in the result envelope", async () => {
  const fixture = await loadFixture("synthetic-normal.json");
  const adapter = new FixtureAdapter(fixture, { environment: RTX_4070_TI });
  const record = await runBenchmark({
    adapter,
    model: fixture.tagsResponse.models[0].name,
    memoryBandwidthGBps: 500,
  });
  assert.equal(record.runtime.environment.source, "client-process-env");
  assert.equal(record.runtime.environment.authoritative, false);
  assert.equal(record.runtime.environment.declared.OLLAMA_KV_CACHE_TYPE, "q8_0");
  assert.ok(
    record.runtime.environment.declaredNonDefault.includes(
      "OLLAMA_FLASH_ATTENTION",
    ),
  );
});

test("an adapter without readEnvironment still produces a record", async () => {
  const fixture = await loadFixture("synthetic-normal.json");
  const adapter = new FixtureAdapter(fixture);
  delete FixtureAdapter.prototype.readEnvironment;
  try {
    const record = await runBenchmark({
      adapter,
      model: fixture.tagsResponse.models[0].name,
      memoryBandwidthGBps: 500,
    });
    assert.equal(record.runtime.environment.source, "client-process-env");
    assert.deepEqual(record.runtime.environment.declaredNonDefault, []);
  } finally {
    FixtureAdapter.prototype.readEnvironment = function readEnvironment() {
      return { ...(this.environment ?? {}) };
    };
  }
});

test("the report names non-default settings and warns when none were recorded", async () => {
  const record = await normalRecord();
  record.derived = deriveMetrics(record);
  record.runtime.environment = deriveRuntimeEnvironment(RTX_4070_TI);
  const withEnvironment = renderReport(record);
  assert.match(withEnvironment, /Runtime environment \(declared, not authoritative\)/);
  assert.match(withEnvironment, /OLLAMA_KV_CACHE_TYPE=q8_0/);
  assert.match(withEnvironment, /only compare against runs declaring the same/);

  record.runtime.environment = null;
  assert.match(renderReport(record), /cannot be shown comparable to any other/);

  record.runtime.environment = deriveRuntimeEnvironment({});
  assert.match(renderReport(record), /no Ollama tuning variables set/);
});

test("the published schema permits the environment block under runtime", async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const schema = JSON.parse(
    await readFile(path.join(root, "schema", "result-v1.schema.json"), "utf8"),
  );
  const environment = schema.properties.runtime.properties.environment;
  assert.ok(environment, "runtime.additionalProperties is false, so the schema must declare it");
  // Optional on purpose: records produced before client 0.8.0 stay valid.
  assert.ok(!schema.properties.runtime.required.includes("environment"));
  assert.equal(environment.properties.authoritative.const, false);
});

test("every allowlisted variable declares a comparability class and a reason", () => {
  for (const variable of OLLAMA_ENVIRONMENT_VARIABLES) {
    assert.ok(
      ["blocking", "advisory"].includes(variable.comparability),
      `${variable.name} needs a comparability class`,
    );
    assert.ok(
      ["value", "presence"].includes(variable.capture),
      `${variable.name} needs a capture mode`,
    );
    assert.equal(typeof variable.reason, "string");
    assert.ok(variable.reason.length > 0);
  }
});
