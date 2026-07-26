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
