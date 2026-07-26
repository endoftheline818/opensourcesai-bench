#!/usr/bin/env node
//
// Prefill-saturation sweep. Answers §12.5: does W3's ~2,650-token prompt sit
// at or past the point where prefill throughput plateaus, or is it still on
// the rising part of the curve where the number depends on prompt length?
//
// Single-stream prefill processes the whole prompt in one batched forward
// pass. For short prompts fixed launch/kernel overhead dominates and
// throughput is low; as the prompt grows the pass becomes compute-bound and
// throughput asymptotes to a ceiling. "Saturated" means on that asymptote.
// This sends prompts of increasing length and reports prefill tok/s at each,
// so the plateau is visible and W3's operating point can be placed on it.
//
// Same constraints as the benchmark: local Ollama loopback only, no other
// network access. Every call gets a unique cache-bust marker (as W3 does, see
// §5.2.1) so no measurement reads a reused KV prefix. This is an exploratory
// diagnostic, not a protocol run: it deliberately sweeps past num_ctx = 4096
// (with a larger context) to see the whole curve, which a fixed protocol run
// never does.
//
//   node scripts/sweep-prefill-saturation.js --model llama3.1:8b
//   node scripts/sweep-prefill-saturation.js --model qwen3:8b --num-ctx 8192

import { OllamaAdapter } from "../src/adapters/ollama.js";
import { extractRawMeasurement } from "../src/derivation/ollama.js";
import { FIXED_OPTIONS } from "../src/protocol.js";

function parseArg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((v) => v.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return fallback;
}

const argv = process.argv.slice(2);
const model = parseArg(argv, "--model", null);
const numCtx = Number(parseArg(argv, "--num-ctx", "8192"));
const measuredPerPoint = Number(parseArg(argv, "--reps", "3"));
if (!model) {
  process.stderr.write(
    "Usage: node scripts/sweep-prefill-saturation.js --model <name> [--num-ctx 8192] [--reps 3]\n",
  );
  process.exit(2);
}

// The W3 base sentence, repeated. 120 repetitions is the protocol's W3 size,
// so it appears in the sweep as the reference operating point.
const SENTENCE =
  "Local inference benchmarks compare repeatable workloads while preserving measured runtime counters and configuration details for later analysis.";
const REPETITION_POINTS = [8, 16, 32, 48, 64, 96, 120, 160, 200, 260, 320];

function buildPrompt(repetitions, callIndex) {
  const body = Array.from(
    { length: repetitions },
    (_, i) => `${i + 1}. ${SENTENCE}`,
  ).join("\n");
  // Unique per call so the runtime cannot reuse a prior call's KV prefix.
  return `[osai-bench sweep ${repetitions}#${callIndex}] ${body}`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function prefillOnce(adapter, repetitions, callIndex) {
  const raw = await adapter.generate(model, {
    prompt: buildPrompt(repetitions, callIndex),
    numPredict: 1,
    numCtx,
    keepAlive: "5m",
  });
  const m = extractRawMeasurement(raw);
  if (!m.prompt_eval_count || !m.prompt_eval_duration) return null;
  return {
    tokens: m.prompt_eval_count,
    tokensPerSecond: m.prompt_eval_count / (m.prompt_eval_duration / 1e9),
    truncated: m.prompt_eval_count >= numCtx,
  };
}

const adapter = new OllamaAdapter();

console.log(`Prefill-saturation sweep for ${model} (num_ctx ${numCtx})`);
console.log(
  `${measuredPerPoint} measured passes per point after one discarded warmup; ` +
    `unique prompt per call.\n`,
);
console.log("reps    tokens   prefill tok/s   CV%     note");
console.log("-".repeat(60));

let callIndex = 0;
const rows = [];
for (const repetitions of REPETITION_POINTS) {
  // Warmup (discarded): loads/settles without a distinct-prompt cache benefit,
  // since the next calls each carry their own marker anyway.
  await prefillOnce(adapter, repetitions, callIndex++);
  const samples = [];
  let tokens = null;
  let truncated = false;
  for (let i = 0; i < measuredPerPoint; i++) {
    const r = await prefillOnce(adapter, repetitions, callIndex++);
    if (!r) continue;
    samples.push(r.tokensPerSecond);
    tokens = r.tokens;
    truncated = truncated || r.truncated;
  }
  if (!samples.length) {
    console.log(`${String(repetitions).padEnd(7)} (no valid measurement)`);
    continue;
  }
  const med = median(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sd =
    samples.length > 1
      ? Math.sqrt(
          samples.reduce((a, b) => a + (b - mean) ** 2, 0) /
            (samples.length - 1),
        )
      : 0;
  const cv = mean ? (sd / mean) * 100 : 0;
  const note = truncated
    ? "TRUNCATED (>= num_ctx)"
    : repetitions === 120
      ? "<- W3 operating point"
      : "";
  rows.push({ repetitions, tokens, tokensPerSecond: med, truncated });
  console.log(
    `${String(repetitions).padEnd(7)} ${String(tokens).padEnd(8)} ` +
      `${med.toFixed(1).padEnd(15)} ${cv.toFixed(2).padEnd(7)} ${note}`,
  );
}

// Plateau analysis: the ceiling is the best point that is not truncated; a
// point is "saturated" once it is within 5% of that ceiling.
const clean = rows.filter((r) => !r.truncated);
if (clean.length) {
  const ceiling = Math.max(...clean.map((r) => r.tokensPerSecond));
  const saturationThreshold = ceiling * 0.95;
  const firstSaturated = clean.find(
    (r) => r.tokensPerSecond >= saturationThreshold,
  );
  const w3 = clean.find((r) => r.repetitions === 120);
  console.log(`\nObserved ceiling: ${ceiling.toFixed(1)} tok/s (best clean point).`);
  if (firstSaturated) {
    console.log(
      `Reaches 95% of ceiling by ${firstSaturated.tokens} tokens ` +
        `(${firstSaturated.repetitions} repetitions).`,
    );
  }
  if (w3) {
    const pct = (w3.tokensPerSecond / ceiling) * 100;
    console.log(
      `W3 operating point (${w3.tokens} tokens): ${w3.tokensPerSecond.toFixed(1)} ` +
        `tok/s = ${pct.toFixed(1)}% of the observed ceiling.`,
    );
    console.log(
      pct >= 95
        ? "W3 sits on the prefill plateau: the number is saturation-bound, not length-sensitive."
        : "W3 is below the plateau: prefill throughput is still rising at its prompt length.",
    );
  }
}
