import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveMetrics } from "../src/derivation/metrics.js";
import {
  defaultResultFilename,
  defaultResultsDirectory,
  writeResult,
} from "../src/output/writer.js";
import { normalRecord } from "./helpers.js";

test("default filename is portable and timestamped", () => {
  assert.equal(
    defaultResultFilename("2026-07-25T12:34:56.789Z"),
    "osai-bench-result-2026-07-25T12-34-56-789Z.json",
  );
});

test("the default results directory is ~/.osai/bench-results", () => {
  // The same spelling on every platform, so Command Center (or any local
  // tool) can offer to open results without being told where they went.
  assert.equal(
    defaultResultsDirectory({ home: path.join("home", "u") }),
    path.join("home", "u", ".osai", "bench-results"),
  );
});

test("without --output the result lands in the default directory, timestamped", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "osai-bench-defaultdir-"));
  const resultsDirectory = path.join(base, ".osai", "bench-results");
  const record = await normalRecord();
  record.derived = deriveMetrics(record);

  // The directory does not exist yet — first run must create it, because a
  // completed measurement discarded over ENOENT is unforgivable.
  const written = await writeResult(record, null, { resultsDirectory });
  assert.equal(path.dirname(written), path.resolve(resultsDirectory));
  assert.equal(path.basename(written), defaultResultFilename(record.createdAt));
  const parsed = JSON.parse(await readFile(written, "utf8"));
  assert.equal(parsed.protocolVersion, record.protocolVersion);

  // An explicit --output still wins over the default directory, unchanged.
  const explicit = path.join(base, "explicit.json");
  assert.equal(await writeResult(record, explicit, { resultsDirectory }), path.resolve(explicit));
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
