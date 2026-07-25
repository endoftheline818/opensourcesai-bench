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
    ]),
    {
      model: "qwen3:8b",
      memoryBandwidthGBps: 760,
      qualityOverride: true,
      outputPath: "result.json",
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
});

test("help states the local-only network boundary", () => {
  const help = __test.usage();
  assert.match(help, /no external network calls/i);
  assert.match(help, /127\.0\.0\.1:11434/);
});
