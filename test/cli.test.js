import test from "node:test";
import assert from "node:assert/strict";
import { __test, resolveInstalledModel } from "../src/cli.js";

test("CLI parses non-interactive protocol arguments", () => {
  assert.deepEqual(
    __test.parseArguments([
      "--model",
      "qwen3:8b",
      "--memory-bandwidth=760",
      "--quality-override",
      "--output",
      "result.json",
      "--capture-fixture",
      "fixtures/rtx-4070-ti.json",
      "--fixture-label",
      "rtx-4070-ti-partial-offload",
    ]),
    {
      model: "qwen3:8b",
      memoryBandwidthGBps: 760,
      qualityOverride: true,
      outputPath: "result.json",
      captureFixturePath: "fixtures/rtx-4070-ti.json",
      fixtureLabel: "rtx-4070-ti-partial-offload",
      help: false,
    },
  );
});

test("CLI rejects unknown, missing, and invalid numeric arguments", () => {
  assert.throws(() => __test.parseArguments(["--remote"]));
  assert.throws(() => __test.parseArguments(["--model"]));
  assert.throws(() =>
    __test.parseArguments(["--memory-bandwidth", "not-a-number"]),
  );
  assert.throws(() => __test.parseArguments(["--memory-bandwidth", "0"]));
  assert.throws(() =>
    __test.parseArguments(["--capture-fixture", "fixture.json"]),
  );
  assert.throws(() =>
    __test.parseArguments(["--fixture-label", "partial-offload"]),
  );
  assert.throws(() =>
    __test.parseArguments([
      "--output",
      "same.json",
      "--capture-fixture",
      "same.json",
      "--fixture-label",
      "partial-offload",
    ]),
  );
});

test("help states the local-only network boundary", () => {
  const help = __test.usage();
  assert.match(help, /no external network calls/i);
  assert.match(help, /127\.0\.0\.1:11434/);
  assert.match(help, /--capture-fixture <path>/);
  assert.match(help, /--fixture-label <text>/);
});

test("a bare model name resolves to the :latest tag Ollama actually created", () => {
  // `ollama create llama3.1-8b-broken` produces `llama3.1-8b-broken:latest`,
  // and /api/tags reports the tagged form. Rejecting the bare name the user
  // typed reads as the tool being broken, since `ollama list` shows it.
  const models = [
    { name: "llama3.1:8b" },
    { name: "llama3.1-8b-broken:latest" },
  ];
  assert.equal(
    resolveInstalledModel(models, "llama3.1-8b-broken"),
    "llama3.1-8b-broken:latest",
  );
  assert.equal(
    resolveInstalledModel(models, "llama3.1-8b-broken:latest"),
    "llama3.1-8b-broken:latest",
  );
  assert.equal(resolveInstalledModel(models, "llama3.1:8b"), "llama3.1:8b");
});

test("an explicit tag never silently falls back to a different one", () => {
  // Model identity is part of the cohort key: resolving a requested :q4 to an
  // installed :q8 would silently pool measurements of two different models.
  const models = [{ name: "llama3.1:8b" }, { name: "mistral:latest" }];
  assert.equal(resolveInstalledModel(models, "llama3.1:70b"), null);
  assert.equal(resolveInstalledModel(models, "mistral:7b"), null);
  assert.equal(resolveInstalledModel(models, "nonexistent"), null);
});

test("model entries reported only as `model` rather than `name` still resolve", () => {
  const models = [{ model: "qwen2.5:7b" }];
  assert.equal(resolveInstalledModel(models, "qwen2.5:7b"), "qwen2.5:7b");
});
