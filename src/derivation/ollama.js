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
  // Optional: absent on any collection result captured before this field
  // existed (including every committed fixture predating it), and null
  // stays a fully valid value — see the adapter's streamedChunkHasVisibleToken
  // comment for what distinguishes this from timeToFirstTokenMs.
  measurement.timeToFirstVisibleTokenMs =
    collectionResult.timeToFirstVisibleTokenMs ?? null;
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

  // Ollama exposes no per-layer GPU/CPU assignment on any released version
  // (checked through 0.32.3: neither /api/show nor /api/ps carries one). This
  // stays null as the explicit record of that absence. Byte-granular placement
  // is reported separately by extractOffloadPlacement -- bytes are not layers
  // and must never be presented as though they were.
  return null;
}

/**
 * Where the loaded model actually sits, in bytes, from /api/ps.
 *
 * `size` is the model's total resident footprint and `size_vram` the portion
 * of it resident in VRAM. This is the same pair Ollama's own CLI uses to print
 * the PROCESSOR column in `ollama ps` ("100% GPU", "65%/35% CPU/GPU"), so it is
 * a direct reading rather than an inference -- verified 2026-07-26 against the
 * CLI on Ollama 0.32.3 and 0.30.10.
 *
 * Two limits, both material:
 *   - This is a fraction of RESIDENT FOOTPRINT, not of layers and not of
 *     weights. `size` includes the KV cache and compute buffers.
 *   - `size` itself moves with placement. The same model measured 5.02 GB
 *     fully on GPU and 5.36 GB partially offloaded, because host-side buffers
 *     differ. So the fraction is only meaningful within a single observation.
 */
export function extractOffloadPlacement(runningEntry) {
  const residentBytes = runningEntry?.size;
  const vramResidentBytes =
    runningEntry?.size_vram ?? runningEntry?.sizeVram ?? null;
  if (
    !Number.isFinite(residentBytes) ||
    !Number.isFinite(vramResidentBytes) ||
    residentBytes <= 0 ||
    vramResidentBytes < 0 ||
    // Ollama's CLI treats this pair as "Unknown" rather than clamping it.
    vramResidentBytes > residentBytes
  ) {
    return null;
  }
  return {
    source: "ollama.ps.size_vram",
    granularity: "bytes",
    residentBytes,
    vramResidentBytes,
    hostResidentBytes: residentBytes - vramResidentBytes,
    vramResidentFraction: vramResidentBytes / residentBytes,
  };
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
