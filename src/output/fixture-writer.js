import { promises as fs } from "node:fs";
import path from "node:path";
import { PROTOCOL_VERSION } from "../protocol.js";
import { CLIENT_VERSION } from "../version.js";
import {
  FIXTURE_SCHEMA_VERSION,
  validateFixtureFormat,
} from "../fixture-format.js";

const MEASUREMENT_FIELDS = Object.freeze([
  "total_duration",
  "load_duration",
  "prompt_eval_count",
  "prompt_eval_duration",
  "eval_count",
  "eval_duration",
]);

const REDACTION_NOTES = Object.freeze([
  "Only the selected /api/tags model is retained; other installed models are omitted.",
  "/api/show is allowlisted; modelfile, template, license, parameters, and all other unneeded fields are omitted.",
  "Every retry attempt is retained in order, but only its final measurement chunk is kept; model output and intermediate chunks are omitted.",
  "Prompt and request bodies are never captured.",
  "Path-like model identifiers are replaced with [REDACTED_LOCAL_PATH].",
  "/api/ps is allowlisted to size, size_vram and the model name; expires_at and all other fields are omitted.",
  "/api/version is allowlisted to the runtime name and version string; nothing else is retained.",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasLocalPath(value) {
  return (
    typeof value === "string" &&
    /^(?:[a-z]:[\\/]|\\\\|\/|~[\\/]|file:\/\/)/i.test(value.trim())
  );
}

function safeIdentifier(value, redactedFields, field) {
  if (typeof value !== "string") return null;
  if (!hasLocalPath(value)) return value;
  redactedFields.push(field);
  return "[REDACTED_LOCAL_PATH]";
}

// A version string is short, single-line free text. Anything else is not a
// version, and is dropped rather than widening the envelope by accident.
function safeVersionString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function selectedTagsResponse(tagsResponse, selectedModel, redactedFields) {
  const models = Array.isArray(tagsResponse?.models) ? tagsResponse.models : [];
  const selected = models.find(
    (entry) => (entry?.name ?? entry?.model) === selectedModel,
  );
  if (!selected) {
    throw new Error("Cannot capture fixture: selected model is absent from /api/tags");
  }

  const identifier = safeIdentifier(
    selected.name ?? selected.model,
    redactedFields,
    "tagsResponse.models[0].name",
  );
  const details = {};
  for (const field of ["family", "parameter_size", "quantization_level"]) {
    const value = selected.details?.[field];
    if (typeof value === "string") details[field] = value;
  }
  const model = {
    name: identifier,
    model: identifier,
  };
  if (typeof selected.size === "number") model.size = selected.size;
  if (typeof selected.digest === "string") model.digest = selected.digest;
  if (Object.keys(details).length > 0) model.details = details;
  return { models: [model] };
}

function sanitizedLayerAssignment(showResponse) {
  const source =
    showResponse?.layer_assignment ?? showResponse?.layerAssignment ?? null;
  if (!isPlainObject(source)) return null;
  const totalLayers = source.total_layers ?? source.totalLayers;
  const gpuLayers = source.gpu_layers ?? source.gpuLayers;
  const cpuLayers = source.cpu_layers ?? source.cpuLayers;
  if (
    !Number.isInteger(totalLayers) ||
    !Number.isInteger(gpuLayers) ||
    !Number.isInteger(cpuLayers)
  ) {
    return null;
  }
  return {
    total_layers: totalLayers,
    gpu_layers: gpuLayers,
    cpu_layers: cpuLayers,
  };
}

function sanitizedModelInfo(showResponse) {
  const source = showResponse?.model_info;
  if (!isPlainObject(source)) return null;
  const architecture =
    typeof source["general.architecture"] === "string"
      ? source["general.architecture"]
      : null;
  if (!architecture) return null;
  const result = { "general.architecture": architecture };
  for (const suffix of [
    "block_count",
    "attention.head_count",
    "attention.head_count_kv",
    "embedding_length",
    "attention.key_length",
  ]) {
    const key = `${architecture}.${suffix}`;
    if (typeof source[key] === "number") result[key] = source[key];
  }
  return result;
}

function sanitizedShowResponse(showResponse) {
  const result = {};
  const details = {};
  for (const field of ["family", "parameter_size", "quantization_level"]) {
    const value = showResponse?.details?.[field];
    if (typeof value === "string") details[field] = value;
  }
  if (Object.keys(details).length > 0) result.details = details;

  const modelInfo = sanitizedModelInfo(showResponse);
  if (modelInfo) result.model_info = modelInfo;
  const layerAssignment = sanitizedLayerAssignment(showResponse);
  if (layerAssignment) result.layer_assignment = layerAssignment;
  return result;
}

// The /api/ps entry for the loaded model, allowlisted to the two byte figures
// the placement diagnostics read (§7.2) plus the identifiers needed to confirm
// the entry belongs to the model under test.
//
// Without this, §11's restored gate is unverifiable by any committed fixture:
// extractOffloadPlacement reads /api/ps at run time, but fixtures carried only
// tagsResponse, showResponse and workloads — so a negative control could
// demonstrate its throughput collapse in CI while the "and fires the
// diagnostic" half of the gate could only ever be checked by hand on live
// hardware. That is exactly the manual-verification situation capture mode
// exists to remove.
//
// `size` and `size_vram` only. `expires_at`, `digest` and the full `details`
// block are omitted: they are either wall-clock state that would make fixtures
// non-deterministic, or already captured under tagsResponse.
function sanitizedPsResponse(psEntry, redactedFields) {
  if (!isPlainObject(psEntry)) return null;
  const residentBytes = psEntry.size;
  const vramResidentBytes = psEntry.size_vram ?? psEntry.sizeVram;
  if (
    !Number.isFinite(residentBytes) ||
    !Number.isFinite(vramResidentBytes)
  ) {
    return null;
  }
  const result = {
    size: residentBytes,
    size_vram: vramResidentBytes,
  };
  // Model identifiers get the same path-redaction treatment as tagsResponse:
  // a model loaded from a local file surfaces its path here too.
  const name = psEntry.name ?? psEntry.model;
  if (typeof name === "string") {
    result.name = safeIdentifier(name, redactedFields, "psResponse.name");
  }
  return result;
}

// The runtime that produced the measurements, allowlisted to its name and
// version string.
//
// Without this a fixture cannot answer "which runtime produced these numbers?"
// — which is the question it exists for the moment a later run disagrees. That
// is not hypothetical: comparing two RTX 3080 runs across an Ollama upgrade
// (0.30.10 -> 0.32.5), the only way to establish which runtime the baseline
// fixture had been captured on was separately-held knowledge of that machine's
// pre-upgrade state. The conclusion held, but nothing in the fixture could have
// falsified it. The value was already fetched from /api/version and already
// recorded in the result record; it simply never reached the fixture envelope.
//
// Name and version only. Ollama exposes no endpoint reporting its resolved
// server configuration (§8.4), so the fixture must not imply it captured one.
function sanitizedRuntime(runtime, redactedFields) {
  if (!isPlainObject(runtime)) return null;
  const name = safeVersionString(runtime.name);
  if (!name) return null;
  const result = { name };
  // Absent and unreported are the same state to a reader and both record null:
  // a runtime that answers /api/version with nothing is no more identifiable
  // than one never asked.
  const version = safeVersionString(runtime.version);
  result.version = version
    ? safeIdentifier(version, redactedFields, "runtime.version")
    : null;
  return result;
}

function sanitizedWorkloadResponse(response) {
  const chunks = Array.isArray(response?.chunks) ? response.chunks : [];
  const final = [...chunks].reverse().find((chunk) => chunk?.done === true);
  const measurement = final ? { done: true } : null;
  if (measurement) {
    for (const field of MEASUREMENT_FIELDS) {
      const value = final[field];
      if (typeof value === "number") measurement[field] = value;
    }
  }
  return {
    chunks: measurement ? [measurement] : [],
    timeToFirstTokenMs:
      typeof response?.timeToFirstTokenMs === "number"
        ? response.timeToFirstTokenMs
        : null,
    timeToFirstVisibleTokenMs:
      typeof response?.timeToFirstVisibleTokenMs === "number"
        ? response.timeToFirstVisibleTokenMs
        : null,
  };
}

function sanitizedWorkloads(workloads) {
  const result = {};
  for (const [id, slots] of Object.entries(workloads ?? {})) {
    if (!Array.isArray(slots)) {
      throw new Error(`Cannot capture fixture: ${id} slots must be an array`);
    }
    result[id] = slots.map((attempts, slotIndex) => {
      if (!Array.isArray(attempts)) {
        throw new Error(
          `Cannot capture fixture: ${id} slot ${slotIndex + 1} attempts must be an array`,
        );
      }
      // Every attempt crosses the same strict numeric allowlist. Invalid
      // attempts receive no broader access to the raw runtime response.
      return attempts.map(sanitizedWorkloadResponse);
    });
  }
  return result;
}

export function buildFixtureCapture({
  label,
  capturedAt,
  model,
  runtime,
  tagsResponse,
  showResponse,
  psResponse,
  workloads,
}) {
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.length > 200 ||
    /[\r\n]/.test(label)
  ) {
    throw new Error(
      "Fixture label must be a non-empty single line of at most 200 characters",
    );
  }
  if (hasLocalPath(label)) {
    throw new Error("Fixture label must not be a local file path");
  }
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("Fixture capture timestamp must be an ISO date-time");
  }

  const redactedFields = [];
  const fixture = {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    fixtureType: "ollama-runtime-responses",
    realHardware: true,
    label,
    capturedAt,
    clientVersion: CLIENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    redactions: {
      rulesApplied: [...REDACTION_NOTES],
      pathValuesRedacted: redactedFields,
    },
    tagsResponse: selectedTagsResponse(
      tagsResponse,
      model,
      redactedFields,
    ),
    showResponse: sanitizedShowResponse(showResponse),
    workloads: sanitizedWorkloads(workloads),
  };
  // Optional: fixtures captured before client 0.10.0 have no psResponse, and a
  // runtime that reports no entry for the model yields none either. Absent is a
  // valid state the placement derivation already handles by returning null.
  const sanitizedPs = sanitizedPsResponse(psResponse, redactedFields);
  if (sanitizedPs) fixture.psResponse = sanitizedPs;
  // Optional on the same terms as psResponse: fixtures captured before this
  // field existed have no runtime block, and absent stays a valid state rather
  // than a loader rejection. It is recorded after psResponse so the key order
  // of an existing fixture is unchanged by recapture.
  const capturedRuntime = sanitizedRuntime(runtime, redactedFields);
  if (capturedRuntime) fixture.runtime = capturedRuntime;
  return validateFixtureFormat(fixture);
}

export async function writeFixtureCapture(
  capture,
  { requestedPath, label, capturedAt },
) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new Error("Fixture capture requires a local output path");
  }
  const fixture = buildFixtureCapture({ ...capture, label, capturedAt });
  const outputPath = path.resolve(requestedPath);
  // Same reasoning as the result writer: never lose a capture to a missing
  // parent directory. The wx flag still prevents overwriting.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { outputPath, fixture };
}

function keys(value) {
  return Object.keys(value ?? {}).sort().join(", ") || "(none)";
}

export function renderFixtureCaptureSummary({ outputPath, fixture }) {
  const firstWorkloadResponse = Object.values(fixture.workloads)
    .flat()
    .flat()
    .find(Boolean);
  const finalChunk = firstWorkloadResponse?.chunks?.[0] ?? {};
  return [
    "",
    `Saved real-hardware fixture: ${outputPath}`,
    "Capture metadata:",
    `- schemaVersion: ${fixture.schemaVersion}`,
    `- fixtureType: ${fixture.fixtureType}`,
    `- realHardware: ${fixture.realHardware}`,
    `- label: ${fixture.label}`,
    `- capturedAt: ${fixture.capturedAt}`,
    `- clientVersion: ${fixture.clientVersion}`,
    `- protocolVersion: ${fixture.protocolVersion}`,
    "Captured fields:",
    `- metadata: redactions`,
    `- tagsResponse.models[0]: ${keys(fixture.tagsResponse.models[0])}`,
    `- tagsResponse.models[0].details: ${keys(fixture.tagsResponse.models[0].details)}`,
    `- showResponse: ${keys(fixture.showResponse)}`,
    `- showResponse.details: ${keys(fixture.showResponse.details)}`,
    `- showResponse.model_info: ${keys(fixture.showResponse.model_info)}`,
    ...(fixture.psResponse
      ? [`- psResponse: ${keys(fixture.psResponse)}`]
      : ["- psResponse: not reported by the runtime at snapshot time"]),
    ...(fixture.runtime
      ? [
          `- runtime: ${fixture.runtime.name} ${
            fixture.runtime.version ?? "(version not reported)"
          }`,
        ]
      : ["- runtime: not identified at capture time"]),
    `- workload response: chunks[0] (${keys(finalChunk)}), timeToFirstTokenMs, timeToFirstVisibleTokenMs`,
    `- workload slots/attempts: ${Object.entries(fixture.workloads)
      .map(
        ([id, slots]) =>
          `${id}=${slots.length} slots/${slots.reduce(
            (sum, attempts) => sum + attempts.length,
            0,
          )} attempts`,
      )
      .join(", ")}`,
    "Redacted or omitted:",
    ...fixture.redactions.rulesApplied.map((note) => `- ${note}`),
    `- path values redacted in this file: ${
      fixture.redactions.pathValuesRedacted.join(", ") || "none"
    }`,
    "Review the fixture before committing it to a public repository.",
  ].join("\n");
}

export const __test = {
  hasLocalPath,
  sanitizedShowResponse,
  sanitizedWorkloadResponse,
};
