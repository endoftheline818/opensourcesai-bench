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
