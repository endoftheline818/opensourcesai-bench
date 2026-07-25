import { GPU_MEMORY_BANDWIDTH_TABLE } from "../../data/gpu-memory-bandwidth-v1.js";

function normalizeDetectionName(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : null;
}

function matchesVram(entry, totalVramBytes) {
  const nominalMiB = entry.match?.nominalVramMiB;
  if (!Number.isFinite(nominalMiB)) return true;
  if (!Number.isFinite(totalVramBytes) || totalVramBytes <= 0) return false;
  const toleranceMiB = Number.isFinite(entry.match?.vramToleranceMiB)
    ? entry.match.vramToleranceMiB
    : 0;
  const detectedMiB = totalVramBytes / 1024 ** 2;
  return Math.abs(detectedMiB - nominalMiB) <= toleranceMiB;
}

export function matchGpuMemoryBandwidth(
  { model, totalVramBytes },
  table = GPU_MEMORY_BANDWIDTH_TABLE,
) {
  const detectedName = normalizeDetectionName(model);
  if (!detectedName || !Array.isArray(table?.entries)) return null;

  const matches = table.entries.filter((entry) => {
    const names = entry.match?.detectionNames ?? [];
    return (
      names.some((name) => normalizeDetectionName(name) === detectedName) &&
      matchesVram(entry, totalVramBytes)
    );
  });

  // Ambiguity is unavailable, never a plausible guess.
  return matches.length === 1 ? matches[0] : null;
}

export function resolveGpuMemoryBandwidth(
  { manualGBps = null, model = null, totalVramBytes = null },
  table = GPU_MEMORY_BANDWIDTH_TABLE,
) {
  if (Number.isFinite(manualGBps) && manualGBps > 0) {
    return {
      memoryBandwidthGBps: manualGBps,
      source: "manual",
      tableVersion: null,
      entryId: null,
    };
  }

  const match = matchGpuMemoryBandwidth({ model, totalVramBytes }, table);
  if (!match) {
    return {
      memoryBandwidthGBps: null,
      source: null,
      tableVersion: table?.schemaVersion ?? null,
      entryId: null,
    };
  }

  return {
    memoryBandwidthGBps: match.memoryBandwidthGBps,
    source: "manufacturer-table",
    tableVersion: table.schemaVersion,
    entryId: match.id,
  };
}

export { GPU_MEMORY_BANDWIDTH_TABLE };
