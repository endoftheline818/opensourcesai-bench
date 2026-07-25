export const PROTOCOL_VERSION = "osai-bench/1.1";
export const SCORING_VERSION = "osai-bench-derive/1.1";

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

export const LONG_PROMPT = Array.from(
  { length: 200 },
  (_, index) => `${index + 1}. ${LONG_PROMPT_SENTENCE}`,
).join("\n");

export const WORKLOADS = Object.freeze({
  w1: Object.freeze({
    id: "w1",
    name: "Cold load",
    prompt: "Reply with one word.",
    intendedPromptTokens: null,
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
    intendedPromptTokens: 32,
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
    intendedPromptTokens: 4096,
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
    intendedPromptTokens: 32,
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
