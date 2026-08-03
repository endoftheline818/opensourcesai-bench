export const PROTOCOL_VERSION = "osai-bench/1.3";
export const SCORING_VERSION = "osai-bench-derive/1.4";

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
    // Discovered on the first real hardware run (protocol 1.2, RTX 4070 Ti,
    // llama3.1:8b): sending the identical prompt on every warmup + measured
    // pass let Ollama's runner reuse the previous call's KV state for the
    // shared prefix. prompt_eval_count still reported ~2,650, but
    // prompt_eval_duration collapsed to ~13ms on every one of the five
    // measured passes — not a few outliers, all of them — producing a
    // reported prefill throughput of ~208,000 tok/s. That is a cache lookup,
    // not a measurement; §12.5 remains unanswered by that run.
    //
    // The fix is a short deterministic marker, unique per call (warmup and
    // every attempt including retries), prepended to the base prompt in
    // benchmark.js. This guarantees the prefix diverges from token 0 on every
    // request regardless of Ollama's internal caching implementation, without
    // depending on an undocumented no-cache flag. keep_alive: 0 was
    // considered and rejected: it does defeat the cache, but only by forcing
    // a full model reload — exactly what W1 already does deliberately, and
    // §5.2 is explicit that W1 is the only workload that measures loading.
    // Applying it to W3 would fold multi-second reload time into every
    // prefill pass, replacing one contamination with a worse one.
    //
    // Scoped to W3 only. W1 is already unaffected (forces an unload before
    // every attempt). W4's generation throughput is unaffected (decode reads
    // through the KV cache regardless of how the prompt entered it). W2's
    // TTFT is dominated by launch overhead per §5.2's own design, so a cache
    // hit on its ~45-token prompt would shave a negligible amount off an
    // already-small prefill component.
    varyPromptPerCall: true,
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

// The exact prompt text sent for a given call. Lives here, beside WORKLOADS,
// rather than in the execution layer (benchmark.js) or a standalone script
// (scripts/diagnose-prompts.js), so both share one definition and cannot drift
// apart on what actually gets sent to the runtime — see §5.2.1.
//
// Pure function of (workload.id, callIndex): the exact text for any call is
// reconstructible from the protocol version and the call sequence alone, so no
// raw-record schema change is needed to keep this reproducible.
export function buildCallPrompt(workload, callIndex) {
  if (!workload.varyPromptPerCall) return workload.prompt;
  return `[osai-bench cache-bust ${workload.id}#${callIndex}] ${workload.prompt}`;
}

export const ROOFLINE_LIMITS = Object.freeze([
  "Applies to generation only. Prefill is compute-bound at scale and has no bandwidth denominator.",
  "The ceiling degrades with context length because KV-cache reads add per-token memory traffic; it is not valid across different context sizes.",
  "100% is unreachable in practice. Utilization is meaningful only for the same hardware and model.",
]);
