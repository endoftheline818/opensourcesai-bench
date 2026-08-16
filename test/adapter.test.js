import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/adapters/ollama.js";

test("Ollama endpoint guard permits only local plain-HTTP loopback", () => {
  assert.doesNotThrow(() => __test.assertLoopbackUrl("http://127.0.0.1:11434"));
  assert.doesNotThrow(() => __test.assertLoopbackUrl("http://localhost:11434"));
  assert.doesNotThrow(() => __test.assertLoopbackUrl("http://[::1]:11434"));
  assert.throws(() => __test.assertLoopbackUrl("https://127.0.0.1:11434"));
  assert.throws(() => __test.assertLoopbackUrl("http://192.168.1.5:11434"));
  assert.throws(() => __test.assertLoopbackUrl("https://example.com"));
});

test("Ollama process detection handles Windows and Linux paths", () => {
  assert.equal(__test.isOllamaProcess("/usr/bin/ollama"), true);
  assert.equal(__test.isOllamaProcess("C:\\Program Files\\Ollama\\ollama.exe"), true);
  assert.equal(__test.isOllamaProcess("/usr/bin/python"), false);
});

test("Ollama's own runner process is recognized, not counted as foreign contention", () => {
  // Exact string observed on the RTX 3080 hardware session: nvidia-smi
  // --query-compute-apps reported this as 5288 MiB of "non-Ollama compute",
  // refusing every run once the model was warm -- deterministically, since
  // keep_alive keeps this process resident, not a one-off precondition blip.
  assert.equal(
    __test.isOllamaProcess("/usr/local/lib/ollama/llama-server"),
    true,
  );
});

test("a standalone llama.cpp server with no ollama path segment still counts as contention", () => {
  // Same basename, unrelated install. The check's actual purpose is excluding
  // Ollama's own compute, not exempting every process named llama-server.
  assert.equal(
    __test.isOllamaProcess("/home/user/llama.cpp/build/bin/llama-server"),
    false,
  );
  assert.equal(
    __test.isOllamaProcess("C:\\llama.cpp\\llama-server.exe"),
    false,
  );
});

test("model-independent preconditions include startup-known conditions", () => {
  const issues = __test.modelIndependentIssues({
    power: { onBattery: true },
    gpu: { utilizationPercent: 25 },
    gpuCount: 2,
    gpuProcesses: [
      { processName: "/usr/bin/ollama", usedMemoryMiB: 600 },
      { processName: "/usr/bin/python", usedMemoryMiB: 600 },
    ],
  });
  assert.deepEqual(
    issues.map((issue) => issue.code),
    [
      "on-battery",
      "gpu-utilization",
      "non-ollama-gpu-memory",
      "multiple-gpus-unsupported",
    ],
  );
});

// A quiet machine in every respect except the one field under test.
const contentionCase = (gpu) => ({
  power: { onBattery: false },
  gpu,
  gpuCount: 1,
  gpuProcesses: [],
});

test("elevated utilization on idle power is not contention", () => {
  // Measured on an RTX 4070 Ti, 2026-08-16: several Electron apps open, Task
  // Manager reporting 4%, the card drawing 65W of 305W at low clocks, and
  // nvidia-smi still reporting 38% because utilization.gpu answers "was a
  // kernel resident" rather than "how much work was done". Before power
  // corroboration this refused every run on an idle machine, and no amount of
  // closing applications fixed it.
  assert.deepEqual(
    __test
      .modelIndependentIssues(
        contentionCase({
          utilizationPercent: 38,
          powerDrawWatts: 65,
          powerLimitWatts: 305,
        }),
      )
      .map((issue) => issue.code),
    [],
  );
});

test("elevated utilization on load power is still refused", () => {
  // Same card during a real ollama generation: 99% and 225W of 305W. The whole
  // point of the gate, and it must survive the fix above.
  const codes = __test
    .modelIndependentIssues(
      contentionCase({
        utilizationPercent: 99,
        powerDrawWatts: 225,
        powerLimitWatts: 305,
      }),
    )
    .map((issue) => issue.code);
  assert.deepEqual(codes, ["gpu-utilization"]);
});

test("utilization is taken at face value when power cannot corroborate", () => {
  // Older cards and restricted drivers report "[N/A]" for power. The fix must
  // never leave the gate weaker than it was on hardware it cannot corroborate,
  // so an uncorroborated reading still refuses.
  for (const gpu of [
    { utilizationPercent: 38, powerDrawWatts: null, powerLimitWatts: null },
    { utilizationPercent: 38, powerDrawWatts: 65, powerLimitWatts: null },
    { utilizationPercent: 38, powerDrawWatts: null, powerLimitWatts: 305 },
    { utilizationPercent: 38, powerDrawWatts: 65, powerLimitWatts: 0 },
  ]) {
    assert.deepEqual(
      __test.modelIndependentIssues(contentionCase(gpu)).map((i) => i.code),
      ["gpu-utilization"],
      `expected a refusal for ${JSON.stringify(gpu)}`,
    );
  }
});

test("utilization at or below the threshold never refuses, whatever the power", () => {
  // A busy card at low utilization is the model loading, not contention.
  assert.deepEqual(
    __test
      .modelIndependentIssues(
        contentionCase({
          utilizationPercent: 10,
          powerDrawWatts: 300,
          powerLimitWatts: 305,
        }),
      )
      .map((issue) => issue.code),
    [],
  );
});

test("different loaded model remains a model-dependent precondition", () => {
  assert.deepEqual(
    __test.modelDependentIssues(
      {
        models: [
          { name: "target:8b" },
          { name: "different:14b" },
        ],
      },
      "target:8b",
    ).map((issue) => issue.code),
    ["different-model-loaded"],
  );
});

test("time-to-first-token fires on the first streamed token in either channel", () => {
  // A non-thinking model streams its first token into `response`. Unchanged
  // behavior: this is what every pre-0.7.0 run measured.
  assert.equal(__test.streamedChunkHasToken({ response: "1", done: false }), true);

  // A reasoning model streams chain-of-thought into a separate `thinking`
  // field while `response` stays empty. §5.2 defines TTFT as the first
  // *streamed* token, so this must count — the fix for qwen3:8b, where W2's
  // entire 128-token budget was spent in the thinking channel and TTFT was
  // wrongly reported unavailable.
  assert.equal(
    __test.streamedChunkHasToken({ response: "", thinking: "Okay", done: false }),
    true,
  );

  // The empty chunks Ollama emits before the first real token (observed:
  // {"response":"","done":false} arrives twice before any content) must NOT
  // start the clock, in either channel.
  assert.equal(__test.streamedChunkHasToken({ response: "", done: false }), false);
  assert.equal(
    __test.streamedChunkHasToken({ response: "", thinking: "", done: false }),
    false,
  );

  // Absent fields are not tokens either.
  assert.equal(__test.streamedChunkHasToken({ done: true }), false);
});

test("visible-token detection ignores the thinking channel entirely", () => {
  // A non-thinking model's first token still counts, same as TTFT.
  assert.equal(
    __test.streamedChunkHasVisibleToken({ response: "1", done: false }),
    true,
  );

  // The exact case this exists for: a chunk with real reasoning content but
  // an empty `response` must NOT count as visible. streamedChunkHasToken
  // returns true for this same chunk -- that divergence is the point.
  assert.equal(
    __test.streamedChunkHasVisibleToken({
      response: "",
      thinking: "Okay",
      done: false,
    }),
    false,
  );
  assert.equal(
    __test.streamedChunkHasToken({
      response: "",
      thinking: "Okay",
      done: false,
    }),
    true,
  );

  assert.equal(
    __test.streamedChunkHasVisibleToken({ response: "", done: false }),
    false,
  );
  assert.equal(
    __test.streamedChunkHasVisibleToken({ done: true }),
    false,
  );
});

test("connection errors name the exact loopback endpoint and action", () => {
  const error = __test.ollamaConnectionError(
    "/api/version",
    new Error("connect ECONNREFUSED"),
  );
  assert.match(
    error.message,
    /http:\/\/127\.0\.0\.1:11434\/api\/version/,
  );
  assert.match(error.message, /Start Ollama and retry/);
});

// --- opensourcesai-bench#24: §3's OS row, enforced ---------------------------
//
// §3 scopes v1 to Windows and Linux, but nothing checked it. Every other §4
// precondition is nvidia-smi-based and therefore no-ops on darwin, so a macOS
// run completed with an empty conditions list and `cohortEligible: true` —
// indistinguishable from a protocol-grade run in every field a consumer keys on.
//
// process.platform is stubbed rather than skipped: this suite runs on a
// supported platform, so without the stub the branch would never execute and the
// test would pass while proving nothing.
function withPlatform(value, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const cleanSystem = {
  power: { onBattery: false },
  gpu: { utilizationPercent: 0 },
  gpuCount: 1,
  gpuProcesses: [],
};

test("#24: an out-of-scope platform refuses even when every hardware check is clean", () => {
  const issues = withPlatform("darwin", () =>
    __test.modelIndependentIssues(cleanSystem),
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["unsupported-platform"],
  );
  // The message must name the platform and the supported set, because the user
  // has to decide whether --quality-override is appropriate for their case.
  assert.match(issues[0].message, /darwin/);
  assert.match(issues[0].message, /win32, linux/);
});

test("#24 must not regress: supported platforms raise no platform condition", () => {
  for (const platform of ["win32", "linux"]) {
    const issues = withPlatform(platform, () =>
      __test.modelIndependentIssues(cleanSystem),
    );
    assert.deepEqual(
      issues,
      [],
      `${platform} must stay clean — a GPU-less Linux CPU-only run is in scope per §3`,
    );
  }
});

test("#24: the platform issue declares itself unresolvable, so the CLI can say so", () => {
  // The wiring, not the logic. cli.test.js proves refusalGuidance() reacts
  // correctly to `resolvable: false`; nothing proved the real issue actually
  // carries it. Mutation testing found this gap: deleting the flag from the
  // adapter left every test green while sending Mac users back to
  // "resolve these conditions and retry", which is the defect it fixes.
  const [issue] = withPlatform("darwin", () =>
    __test.modelIndependentIssues(cleanSystem),
  );
  assert.equal(issue.code, "unsupported-platform");
  assert.equal(issue.resolvable, false);
});

test("#24: resolvable conditions stay unflagged, so their guidance is unchanged", () => {
  const issues = withPlatform("linux", () =>
    __test.modelIndependentIssues({ ...cleanSystem, power: { onBattery: true } }),
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "on-battery");
  assert.equal(issues[0].resolvable, undefined);
});
