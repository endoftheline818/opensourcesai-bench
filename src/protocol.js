export const PROTOCOL_VERSION = "osai-bench/1.2";
export const SCORING_VERSION = "osai-bench-derive/1.3";

export const REPETITIONS = 5;
export const WARMUP_PASSES = 1;
export const MAX_RETRIES = 2;

// Provisional protocol gap: §4 requires a threshold but does not define it.
// This conservative v1 implementation refuses when non-Ollama compute processes
// collectively use more than 512 MiB. Hardware testing and the protocol must
// settle this value before v1.0.0.
export const NON_OLLAMA_GPU_MEMORY_THRESHOLD_MIB = 512;

// §12.1 provisional prompts. They are license-clean original text, but their
// token counts and early-EOS behavior still require hardware testing across
// common instruct-tuned models before the protocol freezes.
export const SHORT_PROMPT =
  "Write a continuous numbered list from 1 through 200. For each number, add one different English noun. Do not explain, summarize, or stop before item 200.";

const LONG_PROMPT_SENTENCE =
  "Local inference benchmarks compare repeatable workloads while preserving measured runtime counters and configuration details for later analysis.";

// Sized from MEASURED token counts, not estimated ones.
//
// History, because both errors are instructive. v1.1 used 200 repetitions
// (~29,900 characters) against a num_ctx of 4,096; the runtime truncated it to
// exactly num_ctx, and because the validity rule compared prompt_eval_count
// against an *intended* 4,096, the truncated count matched and every pass
// validated. W3 reported clean measurements of a prompt it never processed in
// full. The correction dropped to 80 repetitions using a character-based
// estimate of 3.4-4.6 characters per token.
//
// That estimate was wrong in the other direction. Measured against
// llama3.1:8b, 80 repetitions is 11,910 characters and 1,770 tokens — 6.73
// characters per token, roughly 50% more efficient than assumed, because this
// sentence is built from long words that each tokenize to a single token. W3
// then fell below its 2,000-token saturation floor and failed all five passes.
//
// 120 repetitions is ~17,891 characters, ~2,659 tokens on that tokenizer.
// Chosen so the count clears the 2,000 floor even on a tokenizer 25% MORE
// efficient than measured, and stays under num_ctx with >10% headroom even on
// one 25% LESS efficient — both directions, because the two failures above were
// one of each.
//
// The lesson worth keeping: character-based token estimation carries about a
// 2x spread and is unusable for sizing near a boundary. Re-measure with
// scripts/diagnose-prompts.js after any prompt change rather than re-deriving.
export const LONG_PROMPT_REPETITIONS = 120;

export const LONG_PROMPT = Array.from(
  { length: LONG_PROMPT_REPETITIONS },
  (_, index) => `${index + 1}. ${LONG_PROMPT_SENTENCE}`,
).join("\n");

export const WORKLOADS = Object.freeze({
  w1: Object.freeze({
    id: "w1",
    name: "Cold load",
    prompt: "Reply with one word.",
    // No band: w1 measures cold load, not prompt handling. The universal
    // truncation check in validity.js still applies.
    promptTokenRange: null,
    numPredict: 1,
    // Provisional protocol gap: §5.1 says num_ctx is per-workload, but §5.2
    // gives no W1 value.
    numCtx: 512,
    keepAlive: "5m",
    warmups: 0,
    repetitions: 1,
  }),
  w2: Object.freeze({
    id: "w2",
    name: "Short-prompt latency",
    prompt: SHORT_PROMPT,
    // SHORT_PROMPT is ~33-42 tokens depending on the model's tokenizer. The
    // previous rule demanded 32 ±5% — a window of ±1.6 tokens — which a single
    // token of tokenizer variation blows, and which would have failed every w2
    // and w4 pass on most models, leaving the run with no generation or TTFT
    // data at all. The band below is what actually matters: short enough to be
    // interactively realistic, tolerant of how models split digits and
    // punctuation.
    promptTokenRange: Object.freeze({ min: 20, max: 64 }),
    numPredict: 128,
    // Provisional protocol gap: W2/W4 num_ctx values are not specified.
    numCtx: 4096,
    keepAlive: "5m",
    warmups: WARMUP_PASSES,
    repetitions: REPETITIONS,
  }),
  w3: Object.freeze({
    id: "w3",
    name: "Long-prompt prefill",
    prompt: LONG_PROMPT,
    // max is num_ctx - 1: reaching num_ctx is the signature of truncation, not
    // a valid measurement. min is the floor below which prefill is too short to
    // be meaningfully compute-bound; it remains provisional until §12.5 is
    // closed on hardware.
    promptTokenRange: Object.freeze({ min: 2000, max: 4095 }),
    numPredict: 1,
    // §12.5 explicitly identifies 4096 as a provisional starting assumption.
    numCtx: 4096,
    keepAlive: "5m",
    warmups: WARMUP_PASSES,
    repetitions: REPETITIONS,
  }),
  w4: Object.freeze({
    id: "w4",
    name: "Sustained generation",
    prompt: SHORT_PROMPT,
    // Same prompt and therefore the same band as w2.
    promptTokenRange: Object.freeze({ min: 20, max: 64 }),
    numPredict: 512,
    // Provisional protocol gap: W2/W4 num_ctx values are not specified.
    numCtx: 4096,
    keepAlive: "5m",
    warmups: WARMUP_PASSES,
    repetitions: REPETITIONS,
  }),
});

export const FIXED_OPTIONS = Object.freeze({
  temperature: 0,
  seed: 42,
});

export const ROOFLINE_LIMITS = Object.freeze([
  "Applies to generation only. Prefill is compute-bound at scale and has no bandwidth denominator.",
  "The ceiling degrades with context length because KV-cache reads add per-token memory traffic; it is not valid across different context sizes.",
  "100% is unreachable in practice. Utilization is meaningful only for the same hardware and model.",
]);
