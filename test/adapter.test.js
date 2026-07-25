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
