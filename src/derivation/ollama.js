const MEASUREMENT_FIELDS = [
  "total_duration",
  "load_duration",
  "prompt_eval_count",
  "prompt_eval_duration",
  "eval_count",
  "eval_duration",
];

export function finalOllamaChunk(chunks) {
  return [...chunks].reverse().find((chunk) => chunk?.done === true) ?? null;
}

export function extractRawMeasurement(collectionResult) {
  const final = finalOllamaChunk(collectionResult.chunks);
  const measurement = {};
  for (const field of MEASUREMENT_FIELDS) {
    measurement[field] = final?.[field] ?? null;
  }
  measurement.timeToFirstTokenMs =
    collectionResult.timeToFirstTokenMs ?? null;
  return measurement;
}

export function extractModelMetadata(tagsEntry, showResponse) {
  return {
    identifier: tagsEntry?.name ?? tagsEntry?.model ?? null,
    digest: tagsEntry?.digest ?? null,
    family:
      showResponse?.details?.family ??
      tagsEntry?.details?.family ??
      null,
    parameterSize:
      showResponse?.details?.parameter_size ??
      tagsEntry?.details?.parameter_size ??
      null,
    quantization:
      showResponse?.details?.quantization_level ??
      tagsEntry?.details?.quantization_level ??
      null,
    // §12.6 provisional: Ollama's /api/tags `size` is used as the
    // quantized on-disk weight size. Hardware testing must confirm whether it
    // excludes non-weight blobs before protocol freeze.
    weightsBytes:
      typeof tagsEntry?.size === "number" ? tagsEntry.size : null,
    weightsSource:
      typeof tagsEntry?.size === "number" ? "ollama.tags.size" : null,
  };
}

export function extractLayerAssignment(showResponse, runningEntry) {
  const candidates = [
    showResponse?.layer_assignment,
    showResponse?.layerAssignment,
    runningEntry?.layer_assignment,
    runningEntry?.layerAssignment,
  ];

  for (const candidate of candidates) {
    const totalLayers = candidate?.total_layers ?? candidate?.totalLayers;
    const gpuLayers = candidate?.gpu_layers ?? candidate?.gpuLayers;
    const cpuLayers = candidate?.cpu_layers ?? candidate?.cpuLayers;
    if (
      Number.isInteger(totalLayers) &&
      Number.isInteger(gpuLayers) &&
      Number.isInteger(cpuLayers)
    ) {
      return { totalLayers, gpuLayers, cpuLayers, source: "ollama-api" };
    }
  }

  // §12.4 remains open. Do not infer layers from size_vram/size; those bytes
  // are not a machine-readable per-layer assignment.
  return null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function extractKvCacheMetadata(showResponse) {
  const info = showResponse?.model_info;
  if (!info || typeof info !== "object") {
    return {
      source: "ollama.show.model_info",
      architecture: null,
      blockCount: null,
      kvHeadCount: null,
      attentionHeadCount: null,
      embeddingLength: null,
      headDimension: null,
      resolvedElementType: null,
      projectedBytes: null,
      calculationAvailable: false,
      missingInputs: ["architectureMetadata", "resolvedKvCacheElementType"],
    };
  }

  const architecture =
    typeof info["general.architecture"] === "string"
      ? info["general.architecture"]
      : null;
  const prefix = architecture ? `${architecture}.` : null;
  const blockCount = positiveInteger(prefix && info[`${prefix}block_count`]);
  const kvHeadCount = positiveInteger(
    prefix && info[`${prefix}attention.head_count_kv`],
  );
  const attentionHeadCount = positiveInteger(
    prefix && info[`${prefix}attention.head_count`],
  );
  const embeddingLength = positiveInteger(
    prefix && info[`${prefix}embedding_length`],
  );
  const explicitKeyLength = positiveInteger(
    prefix && info[`${prefix}attention.key_length`],
  );
  const derivedHeadDimension =
    embeddingLength &&
    attentionHeadCount &&
    embeddingLength % attentionHeadCount === 0
      ? embeddingLength / attentionHeadCount
      : null;
  const headDimension = explicitKeyLength ?? derivedHeadDimension;
  const missingInputs = [];
  if (!blockCount) missingInputs.push("blockCount");
  if (!kvHeadCount) missingInputs.push("kvHeadCount");
  if (!headDimension) missingInputs.push("headDimension");
  // /api/show describes the model file, not the resolved runtime KV-cache
  // representation. OLLAMA_KV_CACHE_TYPE can change the type actually in use.
  missingInputs.push("resolvedKvCacheElementType");

  return {
    source: "ollama.show.model_info",
    architecture,
    blockCount,
    kvHeadCount,
    attentionHeadCount,
    embeddingLength,
    headDimension,
    resolvedElementType: null,
    projectedBytes: null,
    calculationAvailable: false,
    missingInputs,
  };
}

export function extractResolvedConfiguration(showResponse, workloads) {
  return {
    fixedOptions: { temperature: 0, seed: 42, stream: true },
    workloads: Object.fromEntries(
      Object.entries(workloads).map(([id, workload]) => [
        id,
        {
          numPredict: workload.numPredict,
          numCtx: workload.numCtx,
          keepAlive: workload.keepAlive,
        },
      ]),
    ),
    // Ollama currently exposes model parameters as text. Preserve that raw
    // machine response rather than claiming every runtime default was resolved.
    runtimeModelParameters: showResponse?.parameters ?? null,
    unresolvedRuntimeDefaults: true,
  };
}
