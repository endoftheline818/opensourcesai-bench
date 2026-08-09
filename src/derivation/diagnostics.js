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

  // GPU detection is nvidia-smi-only, so any other accelerator -- Apple Metal,
  // ROCm -- reports `gpu.present: false`. That is a fact about the DETECTOR, not
  // about where the model ran, and the runtime already tells us where it ran.
  // When Ollama reports bytes resident in device memory, "CPU-only" is not a
  // conservative label, it is a false one: a consumer pooling by it would ingest
  // a GPU-bound run into a CPU cohort (opensourcesai-bench#24). Measured on an
  // M1: `vramResidentFraction: 1` at 18.08 tok/s, ~67% of that part's documented
  // bandwidth ceiling -- the GPU-execution band, not CPU thrash.
  //
  // A genuinely GPU-less machine is unaffected, and that is guaranteed rather
  // than hoped: §7.2's forced-state table records `num_gpu 0` -> `size_vram: 0`,
  // so real CPU-only execution reports zero resident device bytes and keeps the
  // CPU-only label below. The discriminator is the runtime's own figure, so no
  // Apple- or vendor-specific detection is introduced here -- deliberately, since
  // a unified-memory lane is §3 revision work and should not block this.
  const undetectedAccelerator =
    !gpuPresent &&
    Number.isFinite(placement?.vramResidentBytes) &&
    placement.vramResidentBytes > 0;
  const UNDETECTED_ACCELERATOR_NOTE =
    "no supported discrete GPU was detected, but the runtime reports the model " +
    "resident in device memory, so this run is not CPU-only";

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
  } else if (!gpuPresent && !undetectedAccelerator) {
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
  } else if ((gpuPresent || undetectedAccelerator) && placement) {
    // Definitional, not inferred: zero bytes resident in VRAM is what
    // CPU-only execution *is*. Ollama's own CLI prints "100% CPU" from this.
    const detected = placement.vramResidentBytes === 0;
    diagnostics.push(
      diagnostic(
        "cpu-only-with-gpu",
        detected ? "detected" : "not-detected",
        detected
          ? "A GPU was detected but none of the model is resident in VRAM; it is executing on the CPU"
          : `${percent(placement.vramResidentFraction)} of the model's resident bytes are in VRAM` +
            (undetectedAccelerator ? ` (${UNDETECTED_ACCELERATOR_NOTE})` : ""),
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
    // `not-applicable` claims the question is meaningless; on an undetected
    // accelerator the question is perfectly meaningful and we simply cannot
    // answer it, because capacity comes from nvidia-smi and there is none here.
    // That is `unavailable`, and the distinction is the whole point of #24.
    const unanswerable = gpuPresent || undetectedAccelerator;
    diagnostics.push(
      diagnostic(
        "weights-exceed-vram",
        unanswerable ? "unavailable" : "not-applicable",
        gpuPresent
          ? "Weight size or total VRAM was unavailable"
          : undetectedAccelerator
            ? `Total device memory is unknown because ${UNDETECTED_ACCELERATOR_NOTE}`
            : "No supported discrete GPU was detected",
      ),
    );
  }

  return diagnostics;
}
