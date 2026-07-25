import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/cli.js";

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
