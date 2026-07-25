function diagnostic(id, status, message, evidence = null) {
  return { id, status, message, evidence };
}

export function deriveDiagnostics({ system, model, runtime, configuration }) {
  const diagnostics = [];
  const assignment = runtime?.layerAssignment ?? null;

  if (
    Number.isInteger(assignment?.cpuLayers) &&
    Number.isInteger(assignment?.totalLayers)
  ) {
    // This intentionally implements the literal §7 rule: CPU layers < total
    // layers. The rule appears logically inverted for full-GPU offload, but the
    // governing spec forbids correcting it unilaterally.
    const detected = assignment.cpuLayers < assignment.totalLayers;
    diagnostics.push(
      diagnostic(
        "partial-cpu-offload",
        detected ? "detected" : "not-detected",
        detected
          ? `${assignment.cpuLayers} of ${assignment.totalLayers} layers are assigned to CPU`
          : "The runtime did not report the §7 partial-offload condition",
        assignment,
      ),
    );
  } else {
    diagnostics.push(
      diagnostic(
        "partial-cpu-offload",
        "unavailable",
        "Ollama did not expose per-layer GPU/CPU assignment in a machine-readable response",
      ),
    );
  }

  const configuredContext = configuration?.workloads?.w3?.numCtx ?? null;
  const required = runtime?.contextMemoryRequiredBytes ?? null;
  const freeAtLoad = system?.gpu?.freeVramBytesAtLoad ?? null;
  if (
    Number.isFinite(required) &&
    Number.isFinite(freeAtLoad) &&
    Number.isFinite(configuredContext)
  ) {
    const detected = required > freeAtLoad;
    diagnostics.push(
      diagnostic(
        "context-vram-headroom",
        detected ? "detected" : "not-detected",
        detected
          ? `Configured context ${configuredContext} exceeds measured free-VRAM headroom`
          : "Configured context fits the runtime-reported free-VRAM headroom",
        { configuredContext, requiredBytes: required, freeVramBytesAtLoad: freeAtLoad },
      ),
    );
  } else {
    diagnostics.push(
      diagnostic(
        "context-vram-headroom",
        "unavailable",
        "The protocol does not define a comfortable-headroom formula and Ollama did not report context memory required",
      ),
    );
  }

  const gpuPresent = Boolean(system?.gpu?.present);
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
  } else {
    diagnostics.push(
      diagnostic(
        "cpu-only-with-gpu",
        gpuPresent ? "unavailable" : "not-applicable",
        gpuPresent
          ? "GPU detected, but Ollama did not report GPU-layer assignment"
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
