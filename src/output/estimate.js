import { WORKLOADS } from "../protocol.js";

// Rough per-pass wall-clock costs, in seconds, used only to tell the user how
// long a run will take before it starts. Deliberately coarse: the point is to
// distinguish "two minutes" from "fifteen" for someone about to sit through
// repeated runs on two cards, not to predict anything.
//
// Derived from the scheduled pass counts, never from a previous run's timings —
// reading those would introduce filesystem state carried between runs, which
// this tool avoids everywhere else.
const SECONDS_PER_PASS = Object.freeze({
  w1: 12, // cold load: a forced unload plus a fresh load dominates
  w2: 6, // 128 tokens from a short prompt
  w3: 8, // prefill-dominated; scales with num_ctx
  w4: 20, // 512 tokens is the longest generation
});

export function estimateRunSeconds() {
  let total = 0;
  for (const workload of Object.values(WORKLOADS)) {
    const perPass = SECONDS_PER_PASS[workload.id] ?? 10;
    total += perPass * (workload.repetitions + workload.warmups);
  }
  return total;
}

export function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes === 0) return `${remainder}s`;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function renderRunEstimate() {
  const seconds = estimateRunSeconds();
  const passes = Object.values(WORKLOADS).reduce(
    (sum, workload) => sum + workload.repetitions + workload.warmups,
    0,
  );
  const measured = Object.values(WORKLOADS).reduce(
    (sum, workload) => sum + workload.repetitions,
    0,
  );
  return (
    `Estimated run time: roughly ${formatDuration(seconds)} ` +
    `(${passes} passes, ${measured} measured). This is an estimate only; ` +
    `w3 at num_ctx ${WORKLOADS.w3.numCtx} dominates on slower hardware, and a ` +
    `pass that retries costs its slot again.`
  );
}
