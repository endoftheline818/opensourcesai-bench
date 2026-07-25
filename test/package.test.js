import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CLIENT_VERSION } from "../src/version.js";
import { GPU_MEMORY_BANDWIDTH_TABLE } from "../data/gpu-memory-bandwidth-v1.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package is public-scoped, executable, dependency-free, and version-aligned", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "@opensourcesai/bench");
  assert.equal(packageJson.publishConfig.access, "public");
  assert.equal(packageJson.bin["osai-bench"], "src/cli.js");
  assert.equal(packageJson.engines.node, ">=20");
  assert.equal(packageJson.version, CLIENT_VERSION);
  assert.ok(packageJson.files.includes("data"));
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test("result schema accepts only protocol 1.1 records", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "schema", "result-v1.schema.json"), "utf8"),
  );
  assert.equal(schema.properties.protocolVersion.const, "osai-bench/1.2");
  assert.deepEqual(
    schema.properties.derived.properties.passFailureRate.required,
    ["failedMeasuredPasses", "totalMeasuredPasses", "percent"],
  );
  assert.deepEqual(
    schema.properties.derived.properties.attemptFailureRate.required,
    ["failedAttempts", "totalAttempts", "percent"],
  );
  assert.ok(
    schema.properties.runtime.required.includes("kvCacheMetadata"),
  );
});

test("bandwidth table is release-blocked and every value has a manufacturer source", () => {
  assert.equal(
    GPU_MEMORY_BANDWIDTH_TABLE.schemaVersion,
    "osai-gpu-memory-bandwidth/2",
  );
  assert.equal(
    GPU_MEMORY_BANDWIDTH_TABLE.releaseStatus,
    "requires-human-verification",
  );
  assert.ok(GPU_MEMORY_BANDWIDTH_TABLE.entries.length > 0);
  for (const entry of GPU_MEMORY_BANDWIDTH_TABLE.entries) {
    assert.ok(entry.id);
    assert.ok(entry.memoryBandwidthGBps > 0);
    assert.ok(entry.match.detectionNames.length > 0);
    assert.ok(entry.source.manufacturer);
    assert.ok([1, 2, 3].includes(entry.sourceTier));
    assert.match(entry.source.url, /^https:\/\/(?:www\.nvidia\.com|images\.nvidia\.com)\//);
    assert.ok(entry.source.title);
    assert.ok(entry.source.locator);
    assert.match(
      entry.source.archiveUrl,
      /^https:\/\/web\.archive\.org\/web\/\d{14}\//,
    );
    assert.match(entry.source.archiveDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("workflow has no stored npm credential reference", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "test.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|npm-token/i);
});

test("synthetic fixtures stay labelled and future real captures meet the fixture contract", async () => {
  const names = await readdir(path.join(root, "fixtures"));
  assert.ok(names.includes("synthetic-normal.json"));
  assert.ok(names.includes("synthetic-misconfigured.json"));
  for (const name of names) {
    const fixture = JSON.parse(
      await readFile(path.join(root, "fixtures", name), "utf8"),
    );
    if (fixture.realHardware === false) {
      assert.match(fixture.fixtureType, /synthetic/);
      assert.equal(typeof fixture.warning, "string");
      continue;
    }
    assert.equal(fixture.realHardware, true);
    assert.equal(fixture.fixtureType, "ollama-runtime-responses");
    assert.equal("warning" in fixture, false);
    assert.equal(typeof fixture.label, "string");
    assert.equal(Number.isFinite(Date.parse(fixture.capturedAt)), true);
    assert.match(fixture.clientVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(fixture.protocolVersion, "osai-bench/1.2");
    assert.ok(Array.isArray(fixture.redactions.rulesApplied));
    assert.ok(Array.isArray(fixture.redactions.pathValuesRedacted));
    assert.deepEqual(Object.keys(fixture.workloads).sort(), [
      "w1",
      "w2",
      "w3",
      "w4",
    ]);
    assert.equal(fixture.tagsResponse.models.length, 1);
  }
});

test("runtime HTTP exists only in the Ollama adapter and is pinned to loopback", async () => {
  async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(fullPath) : [fullPath];
      }),
    );
    return nested.flat();
  }

  const files = (await sourceFiles(path.join(root, "src"))).filter((file) =>
    file.endsWith(".js"),
  );
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (file.endsWith(path.join("adapters", "ollama.js"))) {
      assert.match(source, /http:\/\/127\.0\.0\.1:11434/);
      assert.match(source, /http\.request/);
    } else {
      assert.doesNotMatch(source, /\bhttp\.request|\bhttps\.request|\bfetch\s*\(/);
    }
  }
});
