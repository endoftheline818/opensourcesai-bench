import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CLIENT_VERSION } from "../src/version.js";

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
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test("workflow has no stored npm credential reference", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "test.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|npm-token/i);
});

test("fixtures are explicitly labelled synthetic pending real hardware", async () => {
  const names = await readdir(path.join(root, "fixtures"));
  assert.ok(names.includes("synthetic-normal.json"));
  assert.ok(names.includes("synthetic-misconfigured.json"));
  for (const name of names) {
    const fixture = JSON.parse(
      await readFile(path.join(root, "fixtures", name), "utf8"),
    );
    assert.equal(fixture.realHardware, false);
    assert.match(fixture.fixtureType, /synthetic/);
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
