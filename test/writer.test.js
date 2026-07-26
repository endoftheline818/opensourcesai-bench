import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveMetrics } from "../src/derivation/metrics.js";
import {
  defaultResultFilename,
  writeResult,
} from "../src/output/writer.js";
import { normalRecord } from "./helpers.js";

test("default filename is portable and timestamped", () => {
  assert.equal(
    defaultResultFilename("2026-07-25T12:34:56.789Z"),
    "osai-bench-result-2026-07-25T12-34-56-789Z.json",
  );
});

test("writer creates JSON exclusively and preserves privacy boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osai-bench-test-"));
  const outputPath = path.join(directory, "result.json");
  const record = await normalRecord();
  record.derived = deriveMetrics(record);
  await writeResult(record, outputPath);
  const text = await readFile(outputPath, "utf8");
  const written = JSON.parse(text);
  const keys = [];
  JSON.stringify(written, (key, value) => {
    if (key) keys.push(key);
    return value;
  });
  assert.equal(written.protocolVersion, "osai-bench/1.3");
  assert.equal(text.includes("synthetic token"), false);
  assert.equal(keys.includes("prompt"), false);
  assert.equal(text.includes("hostname"), false);
  assert.equal(text.includes("username"), false);
  assert.equal(keys.includes("response"), false);
  await assert.rejects(() => writeResult(record, outputPath), /EEXIST/);
});
