function diagnostic(id, status, message, evidence = null) {
  return { id, status, message, evidence };
}

function percent(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

export function deriveDiagnostics({ system, model, runtime, configuration }) {
  const diagnostics = [];
  const assignment = runtime?.layerAssignment ?? null;
  // Prefer exact layer counts if Ollama ever reports them; otherwise use the
  // byte-granular placement /api/ps does report. Bytes answer the question
  // these diagnostics ask -- is any of this model executing on the CPU -- even
  // though they cannot answer it per layer.
  const placement = runtime?.offloadPlacement ?? null;
  const gpuPresent = Boolean(system?.gpu?.present);

  if (
    Number.isInteger(assignment?.cpuLayers) &&
    Number.isInteger(assignment?.totalLayers)
  ) {
    const detected =
      assignment.cpuLayers > 0 &&
      assignment.cpuLayers < assignment.totalLayers;
    diagnostics.push(
      diagnostic(
        "partial-cpu-offload",
        detected ? "detected" : "not-detected",
        detected
          ? `${assignment.cpuLayers} of ${assignment.totalLayers} layers are assigned to CPU`
          : "The runtime did not report a partial CPU/GPU layer split",
        assignment,
      ),
    );
  } else if (!gpuPresent) {
    diagnostics.push(
      diagnostic(
        "partial-cpu-offload",
        "not-applicable",
        "No supported discrete GPU was detected; the run is labelled CPU-only",
      ),
    );
  } else if (placement) {
    const detected =
      placement.vramResidentBytes > 0 &&
      placement.vramResidentBytes < placement.residentBytes;
    diagnostics.push(
      diagnostic(
        "partial-cpu-offload",
        detected ? "detected" : "not-detected",
        detected
          ? `${percent(1 - placement.vramResidentFraction)} of the model's resident bytes are on the host, not in VRAM`
          : "The whole resident footprint is on one side; no split between VRAM and host memory",
        placement,
      ),
    );
  } else {
    diagnostics.push(
      diagnostic(
        "partial-cpu-offload",
        "unavailable",
        "Ollama reported no resident-size figures for the model at snapshot time",
      ),
    );
  }

  const configuredContext = configuration?.workloads?.w3?.numCtx ?? null;
  const kvCache = runtime?.kvCacheMetadata ?? null;
  diagnostics.push(
    diagnostic(
      "context-vram-headroom",
      "unavailable",
      "Ollama /api/show does not expose the resolved KV-cache element type actually in use, so v1.1 does not calculate or threshold projected KV-cache VRAM",
      {
        configuredContext,
        availableArchitectureMetadata: kvCache,
        missingInput: "resolvedKvCacheElementType",
      },
    ),
  );

  const gpuLayers = assignment?.gpuLayers;
  if (gpuPresent && Number.isInteger(gpuLayers)) {
    const detected = gpuLayers === 0;
    diagnostics.push(
      diagnostic(
        "cpu-only-with-gpu",
        detected ? "detected" : "not-detected",
        detected
          ? "The runtime assigned no layers to GPU although a GPU was detected"
          : "The runtime assigned at least one layer to GPU",
        { gpuLayers, gpuModel: system.gpu.model ?? null },
      ),
    );
  } else if (gpuPresent && placement) {
    // Definitional, not inferred: zero bytes resident in VRAM is what
    // CPU-only execution *is*. Ollama's own CLI prints "100% CPU" from this.
    const detected = placement.vramResidentBytes === 0;
    diagnostics.push(
      diagnostic(
        "cpu-only-with-gpu",
        detected ? "detected" : "not-detected",
        detected
          ? "A GPU was detected but none of the model is resident in VRAM; it is executing on the CPU"
          : `${percent(placement.vramResidentFraction)} of the model's resident bytes are in VRAM`,
        { ...placement, gpuModel: system.gpu.model ?? null },
      ),
    );
  } else {
    diagnostics.push(
      diagnostic(
        "cpu-only-with-gpu",
        gpuPresent ? "unavailable" : "not-applicable",
        gpuPresent
          ? "GPU detected, but Ollama reported no resident-size figures for the model"
          : "No supported discrete GPU was detected; the run is labelled CPU-only",
      ),
    );
  }

  const weightBytes = model?.weightsBytes ?? null;
  const totalVram = system?.gpu?.totalVramBytes ?? null;
  if (gpuPresent && Number.isFinite(weightBytes) && Number.isFinite(totalVram)) {
    const detected = weightBytes > totalVram;
    diagnostics.push(
      diagnostic(
        "weights-exceed-vram",
        detected ? "detected" : "not-detected",
        detected
          ? "Quantized on-disk model weight size is larger than total VRAM"
          : "Quantized on-disk model weight size does not exceed total VRAM",
        { weightsBytes: weightBytes, totalVramBytes: totalVram },
      ),
    );
  } else {
    diagnostics.push(
      diagnostic(
        "weights-exceed-vram",
        gpuPresent ? "unavailable" : "not-applicable",
        gpuPresent
          ? "Weight size or total VRAM was unavailable"
          : "No supported discrete GPU was detected",
      ),
    );
  }

  return diagnostics;
}
