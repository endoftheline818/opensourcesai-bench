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
  tagsResponse,
  showResponse,
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
    `- workload response: chunks[0] (${keys(finalChunk)}), timeToFirstTokenMs`,
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
