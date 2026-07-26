import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBenchmark } from "../src/benchmark.js";
import {
  extractOffloadPlacement,
  extractRawMeasurement,
} from "../src/derivation/ollama.js";
import { deriveDiagnostics } from "../src/derivation/diagnostics.js";
import { FIXTURE_SCHEMA_VERSION } from "../src/fixture-format.js";
import { CLIENT_VERSION } from "../src/version.js";
import {
  buildFixtureCapture,
  renderFixtureCaptureSummary,
  writeFixtureCapture,
} from "../src/output/fixture-writer.js";
import { FixtureAdapter, loadFixture } from "./helpers.js";

function response(seed) {
  return {
    chunks: [
      { response: `private output ${seed}`, done: false },
      {
        response: `private output ${seed}`,
        done: true,
        total_duration: 2_000_000_000 + seed,
        load_duration: 1_000_000,
        prompt_eval_count: 32,
        prompt_eval_duration: 200_000_000,
        eval_count: 128,
        eval_duration: 1_700_000_000,
        done_reason: "length",
      },
    ],
    timeToFirstTokenMs: 200 + seed,
  };
}

function workloadResponse(seed, { promptEvalCount, evalCount }) {
  const value = response(seed);
  value.chunks.at(-1).prompt_eval_count = promptEvalCount;
  value.chunks.at(-1).eval_count = evalCount;
  return value;
}

function captureSource(model = "fixture-model:8b-q4") {
  const invalidThenValid = [response(3), response(3)];
  invalidThenValid[0].chunks.at(-1).eval_count = 64;
  invalidThenValid[0].chunks.at(-1).eval_duration = 700_000_000;
  invalidThenValid[0].chunks.at(-1).private_attempt_note =
    "/home/alice/failed-attempt";
  return {
    model,
    tagsResponse: {
      models: [
        {
          name: model,
          model,
          modified_at: "2026-07-25T00:00:00Z",
          size: 5_000_000_000,
          digest: "sha256:real-capture",
          details: {
            family: "llama",
            parameter_size: "8B",
            quantization_level: "Q4_K_M",
            format: "gguf",
          },
        },
        {
          name: "private-installed-model:latest",
          size: 1,
        },
      ],
    },
    showResponse: {
      modelfile: "FROM /home/alice/private/model.gguf",
      template: "{{ .Prompt }}",
      parameters: "stop PRIVATE",
      license: "unneeded",
      details: {
        family: "llama",
        parameter_size: "8B",
        quantization_level: "Q4_K_M",
        format: "gguf",
      },
      model_info: {
        "general.architecture": "llama",
        "general.name": "/home/alice/private/model.gguf",
        "llama.block_count": 32,
        "llama.attention.head_count": 32,
        "llama.attention.head_count_kv": 8,
        "llama.embedding_length": 4096,
        "llama.rope.dimension_count": 128,
      },
      layer_assignment: {
        total_layers: 33,
        gpu_layers: 26,
        cpu_layers: 7,
      },
    },
    // Byte figures are the real readings captured from a forced num_gpu 10
    // partial offload (§7.2's verification table), not invented values.
    psResponse: {
      name: model,
      model,
      size: 5_357_646_640,
      size_vram: 1_850_893_925,
      digest: "sha256:real-capture",
      expires_at: "2026-07-25T00:05:00Z",
      details: { family: "llama", parameter_size: "8B" },
    },
    workloads: {
      w1: [[response(1)]],
      w2: [
        [response(2)],
        invalidThenValid,
        ...Array.from({ length: 4 }, (_, index) => [response(index + 4)]),
      ],
      w3: Array.from({ length: 6 }, (_, index) => [
        workloadResponse(index + 8, {
          promptEvalCount: 3100,
          evalCount: 1,
        }),
      ]),
      w4: Array.from({ length: 6 }, (_, index) => [
        workloadResponse(index + 14, {
          promptEvalCount: 32,
          evalCount: 512,
        }),
      ]),
    },
  };
}

test("captured fixture round-trips through the fixture loader without editing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osai-fixture-test-"));
  const outputPath = path.join(directory, "captured.json");
  const captured = await writeFixtureCapture(captureSource(), {
    requestedPath: outputPath,
    label: "rtx-4070-ti-partial-offload",
    capturedAt: "2026-07-25T12:00:00.000Z",
  });
  const fixture = await loadFixture(outputPath);

  assert.deepEqual(fixture, captured.fixture);
  assert.equal(fixture.realHardware, true);
  assert.equal("warning" in fixture, false);
  assert.equal(fixture.label, "rtx-4070-ti-partial-offload");
  assert.equal(fixture.capturedAt, "2026-07-25T12:00:00.000Z");
  assert.equal(fixture.schemaVersion, FIXTURE_SCHEMA_VERSION);
  assert.equal(fixture.clientVersion, CLIENT_VERSION);
  assert.equal(fixture.protocolVersion, "osai-bench/1.3");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(fixture.workloads).map(([id, slots]) => [
        id,
        slots.length,
      ]),
    ),
    { w1: 1, w2: 6, w3: 6, w4: 6 },
  );
  assert.equal(fixture.workloads.w2[1].length, 2);
  assert.equal(
    extractRawMeasurement(fixture.workloads.w2[1][0]).eval_count,
    64,
  );
  assert.equal(
    extractRawMeasurement(fixture.workloads.w2[1][1]).eval_count,
    128,
  );

  const replayed = await runBenchmark({
    adapter: new FixtureAdapter(fixture),
    model: "fixture-model:8b-q4",
  });
  assert.deepEqual(replayed.derived.passFailureRate, {
    failedMeasuredPasses: 0,
    totalMeasuredPasses: 16,
    percent: 0,
  });
  assert.deepEqual(replayed.derived.attemptFailureRate, {
    failedAttempts: 1,
    totalAttempts: 17,
    percent: (1 / 17) * 100,
  });

  const text = await readFile(outputPath, "utf8");
  for (const prohibited of [
    "private output",
    "/home/alice",
    "{{ .Prompt }}",
    "stop PRIVATE",
    "private-installed-model",
    "failed-attempt",
  ]) {
    assert.equal(text.includes(prohibited), false, prohibited);
  }
  assert.equal(text.includes('"response"'), false);
  const keys = [];
  JSON.stringify(fixture, (key, value) => {
    if (key) keys.push(key);
    return value;
  });
  for (const prohibitedKey of [
    "modelfile",
    "template",
    "license",
    "parameters",
    "modified_at",
    "done_reason",
    "response",
  ]) {
    assert.equal(keys.includes(prohibitedKey), false, prohibitedKey);
  }
  await assert.rejects(
    () =>
      writeFixtureCapture(captureSource(), {
        requestedPath: outputPath,
        label: "second-capture",
        capturedAt: "2026-07-25T12:01:00.000Z",
      }),
    /EEXIST/,
  );
});

test("path-like model identifiers are redacted and recorded in the fixture", () => {
  const fixture = buildFixtureCapture({
    ...captureSource("/home/alice/models/private.gguf"),
    label: "path-redaction-check",
    capturedAt: "2026-07-25T12:00:00.000Z",
  });
  assert.equal(
    fixture.tagsResponse.models[0].name,
    "[REDACTED_LOCAL_PATH]",
  );
  // psResponse carries the model identifier too, so a path-like name must be
  // redacted there as well, and both occurrences recorded.
  assert.equal(fixture.psResponse.name, "[REDACTED_LOCAL_PATH]");
  assert.deepEqual(fixture.redactions.pathValuesRedacted, [
    "tagsResponse.models[0].name",
    "psResponse.name",
  ]);
  assert.throws(
    () =>
      buildFixtureCapture({
        ...captureSource(),
        label: "/home/alice/private-label",
        capturedAt: "2026-07-25T12:00:00.000Z",
      }),
    /must not be a local file path/,
  );
});

test("terminal summary names captured fields, counts, redactions, and path", () => {
  const fixture = buildFixtureCapture({
    ...captureSource(),
    label: "summary-check",
    capturedAt: "2026-07-25T12:00:00.000Z",
  });
  const summary = renderFixtureCaptureSummary({
    outputPath: "/tmp/summary-check.json",
    fixture,
  });
  assert.match(summary, /Saved real-hardware fixture: \/tmp\/summary-check\.json/);
  assert.match(summary, /label: summary-check/);
  assert.match(summary, /schemaVersion: osai-bench-fixture\/2/);
  assert.ok(summary.includes(`clientVersion: ${CLIENT_VERSION}`));
  assert.match(summary, /protocolVersion: osai-bench\/1\.3/);
  assert.match(summary, /tagsResponse\.models\[0\]/);
  assert.match(summary, /showResponse\.model_info/);
  assert.match(summary, /w1=1 slots\/1 attempts/);
  assert.match(summary, /w2=6 slots\/7 attempts/);
  assert.match(summary, /model output/i);
  assert.match(summary, /Review the fixture before committing/i);
});

test("fixture loader rejects the old single-response format clearly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osai-fixture-old-"));
  const outputPath = path.join(directory, "old.json");
  const source = captureSource();
  await writeFile(outputPath, JSON.stringify(source));
  await assert.rejects(
    () => loadFixture(outputPath),
    /Unsupported fixture schemaVersion \(missing\).*must be migrated or recaptured/,
  );
});

test("psResponse is captured and allowlisted to the placement figures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osai-fixture-ps-"));
  const outputPath = path.join(directory, "ps.json");
  const { fixture } = await writeFixtureCapture(captureSource(), {
    requestedPath: outputPath,
    label: "ps-capture",
    capturedAt: "2026-07-25T12:00:00.000Z",
  });

  assert.deepEqual(fixture.psResponse, {
    size: 5_357_646_640,
    size_vram: 1_850_893_925,
    name: "fixture-model:8b-q4",
  });
  // expires_at is wall-clock state that would make fixtures non-deterministic;
  // digest and details are already captured under tagsResponse.
  for (const omitted of ["expires_at", "digest", "details", "model"]) {
    assert.equal(omitted in fixture.psResponse, false, `${omitted} must be omitted`);
  }
});

test("a captured fixture can replay the placement diagnostic", async () => {
  // The point of the whole psResponse capture: §11's restored gate requires a
  // negative control to fire the diagnostic for the fault it introduces, and
  // before this a fixture could only ever demonstrate the throughput half.
  const directory = await mkdtemp(path.join(os.tmpdir(), "osai-fixture-replay-"));
  const { fixture } = await writeFixtureCapture(captureSource(), {
    requestedPath: path.join(directory, "replay.json"),
    label: "replay-check",
    capturedAt: "2026-07-25T12:00:00.000Z",
  });

  const placement = extractOffloadPlacement(fixture.psResponse);
  assert.ok(placement, "placement must derive from the captured psResponse alone");

  const diagnostics = deriveDiagnostics({
    system: { gpu: { present: true } },
    runtime: { layerAssignment: null, offloadPlacement: placement },
    model: {},
    configuration: {},
  });
  const partial = diagnostics.find((d) => d.id === "partial-cpu-offload");
  assert.equal(
    partial.status,
    "detected",
    "a fixture captured under partial offload must replay as detected",
  );
});

test("a fixture with no psResponse still loads, and reports placement unavailable", async () => {
  // Every fixture captured before client 0.10.0 has no psResponse. They stay
  // valid; the diagnostic degrades to unavailable rather than the loader
  // rejecting them.
  const directory = await mkdtemp(path.join(os.tmpdir(), "osai-fixture-nops-"));
  const source = captureSource();
  delete source.psResponse;
  const { fixture } = await writeFixtureCapture(source, {
    requestedPath: path.join(directory, "nops.json"),
    label: "no-ps",
    capturedAt: "2026-07-25T12:00:00.000Z",
  });

  assert.equal("psResponse" in fixture, false);
  assert.equal(extractOffloadPlacement(fixture.psResponse), null);
});
