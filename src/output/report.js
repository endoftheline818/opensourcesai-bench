import { ROOFLINE_LIMITS } from "../protocol.js";

function number(value, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "unavailable"
    : value.toFixed(digits);
}

function metricLine(label, summary, unit) {
  return `${label.padEnd(30)} ${number(summary.median)} ${unit}  (CV ${number(
    summary.coefficientOfVariation === null
      ? null
      : summary.coefficientOfVariation * 100,
  )}%)`;
}

export function renderReport(record) {
  const { derived } = record;
  const lines = [
    "",
    "OpenSourcesAI Bench",
    "===================",
    `Model:                         ${record.model.identifier}`,
    `Runtime:                       Ollama ${record.runtime.version ?? "unknown"}`,
    `Protocol / client / scoring:  ${record.protocolVersion} / ${record.clientVersion} / ${record.scoringVersion}`,
    `Quality override:              ${record.qualityOverride ? "yes (excluded from cohorts)" : "no"}`,
    "",
    metricLine(
      "Generation throughput",
      derived.generationTokensPerSecond,
      "tok/s",
    ),
    metricLine("Prefill throughput", derived.prefillTokensPerSecond, "tok/s"),
    metricLine("Time to first token", derived.timeToFirstTokenMs, "ms"),
    `${"Cold load time".padEnd(30)} ${number(derived.coldLoad.seconds)} s`,
    `${"Pass failure rate".padEnd(30)} ${number(derived.passFailureRate.percent)}% (${derived.passFailureRate.failedMeasuredPasses}/${derived.passFailureRate.totalMeasuredPasses} scheduled measured passes)`,
    `${"Attempt failure rate".padEnd(30)} ${number(derived.attemptFailureRate.percent)}% (${derived.attemptFailureRate.failedAttempts}/${derived.attemptFailureRate.totalAttempts} measured-pass attempts)`,
    "",
  ];

  if (derived.roofline.utilization === null) {
    lines.push(
      "Roofline utilization          unavailable (model weight size and memory bandwidth are required)",
    );
  } else {
    lines.push(
      `Roofline utilization          ${number(derived.roofline.utilization * 100)}% (generation only)`,
      `Theoretical bandwidth ceiling ${number(derived.roofline.theoreticalMaxTokensPerSecond)} tok/s`,
    );
  }

  lines.push("", "Roofline limits:");
  for (const limit of ROOFLINE_LIMITS) lines.push(`- ${limit}`);

  lines.push("", "Diagnostics:");
  for (const diagnostic of derived.diagnostics) {
    lines.push(
      `- ${diagnostic.id}: ${diagnostic.status} — ${diagnostic.message}`,
    );
  }

  lines.push("", "Runtime environment (declared, not authoritative):");
  const environment = record.runtime.environment ?? null;
  if (!environment) {
    lines.push(
      "- not recorded (client predates environment capture); this run cannot be shown comparable to any other",
    );
  } else if (environment.declaredNonDefault.length === 0) {
    lines.push("- no Ollama tuning variables set in the client environment");
  } else {
    for (const name of environment.declaredNonDefault) {
      const value = environment.declared[name];
      lines.push(`- ${name}=${value === true ? "(set)" : value}`);
    }
    lines.push(
      "- these change what is measured; only compare against runs declaring the same values",
    );
  }

  lines.push(
    "",
    "Configuration:",
    `- OS: ${record.system.os.platform} ${record.system.os.version}`,
    `- CPU: ${record.system.cpu.model ?? "unknown"}`,
    `- RAM: ${number(record.system.memory.totalBytes / 1024 ** 3)} GiB`,
    `- GPU: ${
      record.system.gpu.present
        ? `${record.system.gpu.model} (${number(
            record.system.gpu.totalVramBytes / 1024 ** 3,
          )} GiB VRAM, driver ${record.system.gpu.driverVersion ?? "unknown"})`
        : "CPU-only (no supported discrete GPU detected)"
    }`,
    `- Quantization: ${record.model.quantization ?? "unknown"}`,
    `- Parameter size: ${record.model.parameterSize ?? "unknown"}`,
    `- GPU memory bandwidth: ${
      record.configuration.memoryBandwidthGBps === null
        ? "unavailable"
        : `${number(record.configuration.memoryBandwidthGBps)} GB/s (${record.configuration.memoryBandwidthSource})`
    }`,
  );
  return lines.join("\n");
}
