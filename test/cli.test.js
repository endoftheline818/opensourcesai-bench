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

// --- refusal guidance must be followable -------------------------------------
//
// Introduced alongside the §3 platform precondition (#24). Every §4 condition
// before it was clearable by the operator, so "resolve these conditions and
// retry" was always sound. It is not sound for a platform condition, and
// unfollowable advice is worse than terse advice.

test("a resolvable refusal still tells the operator to resolve and retry", () => {
  const text = __test.refusalGuidance([
    { code: "on-battery", message: "System is running on battery power" },
  ]);
  assert.match(text, /Resolve these conditions and retry/);
  assert.match(text, /--quality-override/);
});

test("an unresolvable refusal does not tell the operator to resolve it", () => {
  const text = __test.refusalGuidance([
    { code: "unsupported-platform", resolvable: false, message: "…" },
  ]);
  assert.doesNotMatch(text, /Resolve these conditions and retry/);
  assert.match(text, /Retrying will not clear this/);
  assert.match(text, /--quality-override/);
  // The measurements are not the problem — say so, or a first-time Mac user
  // reasonably concludes the tool does not work on their machine.
  assert.match(text, /without discarding your numbers/);
});

test("one unresolvable condition makes the whole retry futile, even beside a clearable one", () => {
  // The mixed case is the one a naive `every`/count-based check gets wrong: a
  // Mac with a stray model loaded has a condition the operator CAN clear, but
  // retrying still cannot produce a clean run.
  const text = __test.refusalGuidance([
    { code: "different-model-loaded", message: "…" },
    { code: "unsupported-platform", resolvable: false, message: "…" },
  ]);
  assert.match(text, /Retrying will not clear this/);
  assert.doesNotMatch(text, /Resolve these conditions and retry/);
});

// #25: a third guidance case. A model that cannot satisfy the prompt bands is
// neither a condition the operator resolves on this machine nor a property of
// the machine at all — and both existing branches say something false about it.
test("a model-fit refusal names the one action that works: pick a different model", () => {
  const text = __test.refusalGuidance([
    {
      code: "prompt-count-out-of-range-precondition",
      resolution: "select-a-different-model",
      message: "…",
    },
  ]);
  assert.match(text, /Select a different model/);
  assert.match(text, /property of the model/);
  assert.doesNotMatch(text, /Resolve these conditions and retry/);
  // The machine branch is actively wrong here: nothing is wrong with the
  // machine, and telling the operator otherwise sends them to check hardware.
  assert.doesNotMatch(text, /property of the machine/);
  assert.match(text, /--quality-override/);
});

test("a model-fit refusal beside a machine condition gets both, not one or the other", () => {
  const text = __test.refusalGuidance([
    {
      code: "prompt-count-out-of-range-precondition",
      resolution: "select-a-different-model",
      message: "…",
    },
    { code: "unsupported-platform", resolvable: false, message: "…" },
  ]);
  assert.match(text, /Select a different model/);
  assert.match(text, /property of the machine/);
});

test("--quality-override help distinguishes the precondition gate from the validity checks", () => {
  // The flag reads as though it would force a band-missing model through. It
  // does not, and never did: it governs the precondition phase, while the
  // per-pass validity checks are unconditional. Running with it produces the
  // identical failure rates, which is correct behaviour and misleading help.
  const text = __test.usage();
  assert.match(text, /--quality-override/);
  assert.match(text, /does NOT\s+relax the §5\.4 per-pass validity checks/);
  assert.match(text, /cohort-ineligible/);
});
