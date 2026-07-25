# OpenSourcesAI Bench — Measurement Protocol v1.2

**Status:** DRAFT. Not frozen. Freeze at first public release (`v1.0.0`); version from there.
**Applies to:** `@opensourcesai/bench` client, protocol identifier `osai-bench/1.2`.
**Companion document:** the recommendation-governance boundary lives in the site repo
(`opensourcesai-frontend/docs/`), not here. This document constrains *measurement*;
that one constrains *what the resulting data may influence*.

---

## 1. Purpose

Produce comparable, reproducible measurements of a local LLM inference setup, such that
two runs are meaningfully comparable when — and only when — they share a protocol version,
a runtime, a model, a quantization, and a context configuration.

### 1.1 Non-goals for v1

- **No composite score.** v1 reports measurements only. A weighted "Setup Score" requires
  empirically justified weights, which requires data that does not yet exist. Shipping
  arbitrary weights now means either living with them permanently or moving every user's
  score later for reasons they did not cause.
- **No named Efficiency or Stability score.** The underlying numbers (roofline utilization,
  run-to-run variance) are reported directly. Normalizing them into branded 0–100 scores
  waits for a cohort.
- **No network access of any kind except the local Ollama loopback endpoint.** v1 has no
  upload, no telemetry, no version check. An audit that finds zero outbound calls is worth
  more than a privacy policy.
- **No thermal measurement.** Temperature reporting is inconsistent across vendors and
  platforms, and thermals reflect ambient conditions, case, and fan curves — not setup
  quality. May return later as an optional diagnostic, never as a score input.

---

## 2. Versioning

Every result record carries three independent versions:

| Field | Meaning |
|---|---|
| `protocolVersion` | This document. Changes when measurement semantics change. |
| `clientVersion` | The npm package version that produced the record. |
| `scoringVersion` | The derivation rules applied to raw measurements. |

**Raw measurements are immutable and are the source of truth. All derived figures are
recomputable from them.** A scoring change must never orphan history — it recomputes it.
Records whose `protocolVersion` differs are never pooled or compared. In particular,
`osai-bench/1`, `osai-bench/1.1` and `osai-bench/1.2` records are distinct populations and must
never be pooled. 1.2 changed both the W3 prompt and the prompt-length validity rule, so its
measurements are not comparable with earlier ones.

---

## 3. Supported configurations (v1)

| Axis | v1 support |
|---|---|
| Runtime | Ollama only |
| OS | Windows, Linux |
| Accelerator | Single discrete GPU, or CPU-only (labelled) |
| Model | Any Ollama-pullable model the user selects |

Multi-GPU, Apple Silicon unified memory, and other runtimes (LM Studio, llama.cpp, vLLM,
GPUStack) are out of scope for v1. The adapter interface (§10) is shaped to accept them
without a protocol revision, provided they expose equivalent timing data.

---

## 4. Run-quality preconditions

Data quality is enforced at collection, not modelled around later. A run is **refused**
(not merely flagged) when any of these hold:

| Condition | Rationale |
|---|---|
| System on battery power | Power limits distort throughput unpredictably |
| Pre-existing GPU utilization > 10% at check time | Another workload is competing |
| Pre-existing GPU memory in use by a non-Ollama process above a threshold | Contention and reduced available VRAM |
| Ollama reports a model already loaded that is not the target model | Cold-load timing invalid |

Refusal must state the specific condition and be overridable only by an explicit flag that
**marks the record permanently as `qualityOverride: true`**. Overridden records are excluded
from all cohort statistics.

---

## 5. Measurement protocol

### 5.1 Fixed parameters

All runs fix the following. These are protocol constants, not user-configurable:

```text
temperature      = 0
seed             = 42
num_predict      = <per workload, below>
num_ctx          = <per workload, below>
stream           = true          # required for client-side TTFT
keep_alive       = <per workload, below>
```

Everything else is left at the runtime's defaults, and the resolved values are **recorded**.
The protocol does not tune the setup — it measures the setup as configured, which is the
entire point.

> **Determinism caveat.** Fixed seed and zero temperature do not guarantee identical output
> across runtime versions, quantization formats, or GPU backends — kernel differences and
> non-deterministic reductions break that. This is acceptable because v1 measures *speed*,
> not output equivalence. It is the reason §5.4 validates token counts rather than assuming them.

### 5.2 Workloads

Four workloads, run in this order:

**W1 — Cold load.** Force unload (`keep_alive: 0` on a prior trivial request), then issue a
minimal request. Record `load_duration`. This is the only workload that measures loading;
all others run warm.

**W2 — Short-prompt latency.** Short prompt, accepted band 20-64 tokens. `num_predict = 128`.
Measures **time to first token** as observed wall-clock from request dispatch to first
streamed token. This deliberately includes launch overhead, scheduling, and CPU involvement,
because that is what a user experiences.

**W3 — Long-prompt prefill.** Long prompt, accepted band 2000 tokens to `num_ctx - 1`.
`num_predict = 1`. Measures prefill throughput in a regime where the GPU is actually saturated.

> **The prompt must fit inside `num_ctx`, with margin.** v1.1 specified "~4096 tokens" against a
> `num_ctx` of 4096 and shipped a prompt roughly twice that size. The runtime truncated it to
> exactly `num_ctx`, and because the validity rule compared `prompt_eval_count` against an
> *intended* 4096, the truncated count matched the intended count and every pass validated. W3
> reported clean measurements of a prompt it never processed in full. The prompt is now sized
> with headroom below `num_ctx`, and §5.4 checks the count against the context window itself.

> **Why two prompt lengths.** Prefill is only compute-bound once the workload is large enough
> to saturate. Short-prompt prefill is dominated by launch overhead, CPU involvement, and
> runtime implementation. Reporting a single "prompt processing speed" silently averages two
> different physical regimes and will not be stable across runtimes. W2 and W3 are reported
> separately and must never be combined.

**W4 — Sustained generation.** Same short prompt and band as W2. `num_predict = 512`.
Measures generation throughput, the primary bandwidth-bound metric.

### 5.3 Repetitions for variance

Repetitions determine the samples used to report variance. They are independent of the
validity retries in §5.4.

- W1 has **1 measured pass** and no warmup. Cold-load variance is out of scope.
- W2, W3, and W4 each have **1 discarded warmup + 5 measured passes**.
- Report **median** as the headline figure and **coefficient of variation** across the five
  measured passes as the consistency figure.

### 5.4 Retries for validity

Retries recover from invalid measured passes. They do not add samples to the repetition count.
Every measured pass, **including W1**, is invalid and must be retried up to two times before
that measured pass and its workload are marked failed, when:

- `eval_count` ≠ `num_predict` for W2/W4 — the model emitted EOS early, so `eval_duration`
  covers fewer tokens than intended and is not comparable. **Prompts for W2 and W4 must be
  chosen to elicit long continuations** to make this rare; the check exists because it cannot
  be prevented outright.
- `prompt_eval_count` reaches or exceeds `num_ctx` — the signature of a truncated prompt. This
  check applies to **every** workload, including those with no band of their own. A rule that
  only compares the count against an expected value cannot detect truncation, because when the
  expectation happens to equal `num_ctx` the truncated count lands exactly on it;
- `prompt_eval_count` falls outside the workload's accepted band (§5.2). The band replaces
  v1.1's "within 5% of an intended value". A percentage tolerance is reasonable at 4096 tokens
  (±205) and unusable at 32 (**±1.6**), where a single token of tokenizer variation between two
  models exceeds it — which would have failed every W2 and W4 pass on most models, leaving a
  completed run with no generation or time-to-first-token data at all. Token counts are
  model-dependent; a band states what is acceptable instead of guessing an exact value; or
- any duration field is zero or absent.

Each W1 retry performs another forced unload before the replacement request. This preserves
the cold-load property: W1 still contributes one measured pass, while its raw record retains
all attempts. Warmups are discarded and are not validity-retried.

Failed measured passes and workloads are recorded, not omitted.

---

## 6. Derived metrics

### 6.1 From Ollama's response fields

Ollama returns nanosecond durations and token counts, so throughput is computed from the
runtime's own accounting rather than from client-side wall-clock:

```text
generationTokensPerSecond = eval_count        / (eval_duration        / 1e9)     # W4
prefillTokensPerSecond    = prompt_eval_count / (prompt_eval_duration / 1e9)     # W3
coldLoadSeconds           = load_duration / 1e9                                   # W1
timeToFirstTokenMs        = <client-side, W2>                                     # W2
runToRunCV                = sampleStdDev / mean, per repeated workload
sampleStdDev              = sqrt(sum((x - mean)^2) / (n - 1))
passFailureRate           = passes that exhausted all retries / scheduled measured passes
attemptFailureRate        = attempts failing §5.4 / all measured-pass attempts including retries
```

The CV uses the **sample standard deviation (`n - 1`)**. For the repeated workloads, `n = 5`.
`total_duration` is recorded but not used in any derived figure — it includes overheads the
other fields already partition.

Two failure rates are reported. The pass failure rate counts scheduled measured passes that
exhausted their retries, over the total number of scheduled measured passes. The attempt failure
rate counts every measured-pass attempt failing a §5.4 check, over the total number of
measured-pass attempts including retries. Discarded warmup passes are excluded from both. A run
that completes with no failed passes but a non-zero attempt failure rate is recovering from
instability, and both figures are required to see that. The raw numerator and denominator are
preserved alongside each percentage.

Under the fixed protocol, a complete run schedules 16 measured passes: 1 for W1 and 5 each for
W2/W3/W4. A pass that becomes valid on retry is not a failed scheduled pass, but each invalid
attempt remains visible in the attempt failure rate.

### 6.2 Roofline utilization

Single-stream autoregressive decode requires reading the full weight set per generated token,
making it memory-bandwidth-bound. This yields a theoretical ceiling computable from hardware
specs alone, with no dataset:

```text
theoreticalMaxTokensPerSecond = memoryBandwidthGBps / modelWeightsGB
rooflineUtilization           = generationTokensPerSecond / theoreticalMaxTokensPerSecond
```

`modelWeightsGB` is the **quantized on-disk weight size**, not parameter count.
`memoryBandwidthGBps` comes from a versioned, bundled GPU table or an explicit manual override.
Every table row must cite the manufacturer specification from which its value was taken. A GPU
without a sourced row has no bandwidth denominator: utilization is unavailable while throughput
remains reported. Manual input always overrides a table match.

The bundled table requires human verification before release. It is static package data and
causes no network access.

**Stated limits — these must appear wherever the number is displayed:**

- Applies to **generation only**. Prefill is compute-bound at scale and has no bandwidth
  denominator. There is no TFLOPs figure in the hardware data, so v1 reports prefill
  throughput as a bare number with no utilization percentage.
- The ceiling **degrades with context length**, because KV cache reads add to per-token
  memory traffic. v1 fixes context per workload so figures are comparable to each other;
  the ceiling is not valid across different context sizes.
- 100% is unreachable in practice. The number is only meaningful compared against the same
  hardware and model, which is why §8 governs how it may be presented.

### 6.3 What v1.1 reports

```text
Generation throughput          tok/s   (median of 5)
Prefill throughput             tok/s   (median of 5)
Time to first token            ms      (median of 5)
Cold load time                 s       (single measured pass)
Run-to-run variation           CV %    (sample standard deviation, per repeated workload)
Pass failure rate              %       (passes exhausting retries / scheduled measured passes)
Attempt failure rate           %       (§5.4 failures / measured-pass attempts including retries)
Roofline utilization           %       (generation only, with §6.2 limits attached)
Full configuration + versions
```

No aggregate. No 0–100 normalization. No letter grade.

---

## 7. Diagnostics — detected, not inferred

The client does **not** tell the user what a well-configured system "should" reach. That
target does not exist without a cohort, and asserting one is false precision.

Instead it reports **specific conditions read directly from the runtime**, each of which is
independently verifiable and independently actionable:

| Diagnostic | Detection |
|---|---|
| Partial CPU offload | `cpuLayers > 0 && cpuLayers < totalLayers`, as reported by the runtime |
| Context exceeds comfortable VRAM headroom | Unavailable in v1.1; see below |
| CPU-only execution despite a present GPU | No GPU layers assigned while a GPU is detected |
| Quantization larger than available VRAM permits | Weight size vs. VRAM |

The partial-offload condition deliberately excludes both endpoints: zero CPU layers is full GPU
offload, while CPU layers equal to total layers is CPU-only execution and belongs to the separate
CPU-only diagnostic.

A report reading *"61% of bandwidth ceiling; 7 of 33 layers on CPU"* is more useful and more
defensible than any percentage target, and it holds at n=1.

### 7.1 Context VRAM headroom availability

Ollama `/api/show` exposes architecture metadata in `model_info` for supported GGUF models,
including architecture-prefixed block count, attention head count, KV head count, and embedding
length. Head dimension can often be obtained directly or derived as
`embeddingLength / attentionHeadCount`.

It does **not** expose the resolved KV-cache element type actually in use. That type is a runtime
choice and can be changed independently of the model metadata. Without bytes per element, the
candidate calculation

```text
2 × blocks × kvHeads × headDim × numCtx × bytesPerElement
```

cannot produce an authoritative projected byte count. v1.1 therefore reports the headroom
diagnostic as **unavailable** and defines no threshold. It must not assume a default element type
or substitute a plausible byte count.

For this diagnostic to become available, Ollama must expose the resolved K and V cache element
types actually used for the loaded runner, together with the architecture metadata above (and
separate key/value dimensions where an architecture requires them). Only then may a protocol
revision define and justify a concrete VRAM fraction threshold.

---

## 8. Cohort comparison (specified now, implemented later)

Not in the v1 client — it requires the server side. Specified here so the client records
everything the comparison will need.

### 8.1 Pooling ladder

Comparison proceeds down this ladder until a level qualifies. **The level used is always
displayed alongside the result.**

| Level | Cohort key |
|---|---|
| 1 | Exact: GPU × model × quant × context × runtime version × driver version × OS |
| 2 | Same GPU × model family × quant × runtime (major version) |
| 3 | Same GPU × approximate model size band × approximate quant band |
| 4 | **No cohort** — hardware-derived roofline only |

### 8.2 Gates

A percentile is shown only when **both** hold:

- `n ≥ 10` distinct submitting accounts (not distinct records — one user cannot populate a cell)
- Interquartile range ≤ 40% of the median (dispersion gate)

Below either threshold, results are labelled **"early estimate"** and no percentile is shown.

**Level 4 is not a weak percentile — it is a different kind of statement.** It must be
visually and verbally distinct from levels 1–3 and must never use percentile language.

### 8.3 Version drift

Runtime version is part of the cohort key *and* must be annotated on any history view. A
user whose throughput improves because Ollama shipped a faster kernel — with no action on
their part — will otherwise read it as a defect in the benchmark.

---

## 9. Privacy

### 9.1 Collected

CPU model · GPU model · VRAM · system RAM · OS and version · GPU driver version ·
runtime name and version · model identifier, family, parameter count, quantization ·
context configuration · all measurements above · all three version identifiers.

### 9.2 Never collected

Local file paths or directory contents · conversation history · user prompts · model outputs ·
hostname, username, MAC, or serial numbers · installed software inventory · any identifier
not required to interpret a measurement.

### 9.3 Quasi-identification

The tuple `CPU + GPU + RAM + OS + driver version` is itself distinguishing for unusual
configurations. Any future **public** display (leaderboard, aggregate page) requires a
k-anonymity threshold on the displayed cell, independent of the §8.2 statistical gates,
which serve a different purpose. Private profile display is unaffected.

### 9.4 Consent layers

Three independent, separately revocable levels: local-only (v1 default and only mode) →
private account history → anonymized inclusion in aggregates. Consent to one is never
consent to the next.

---

## 10. Client architecture constraint

The client separates, at a module boundary:

- **Collection** — one adapter per runtime. Calls the runtime, captures raw response. Requires hardware.
- **Derivation** — pure functions over raw measurements. Requires nothing.

Recorded real runtime responses are committed as fixtures, **including at least one from a
deliberately misconfigured setup**. This makes every derivation rule, diagnostic trigger, gate,
and the §11 negative control testable in ordinary CI with no GPU present.

---

## 11. Negative control (release gate)

Before first publication, the protocol must be run against a knowingly broken configuration —
forced partial offload, oversized context, forced CPU fallback — and must be shown to produce
materially worse numbers and to fire the corresponding §7 diagnostics.

**If a badly configured machine scores well, the protocol measures nothing.** This is the
single cheapest test that validates the entire premise, and it gates the freeze.

---

## 12. Open questions — resolve during hardware testing, before freeze

1. Exact prompt texts for W2/W3/W4. Must be license-clean, English, and chosen so W2/W4 rarely
   trigger early EOS across common instruct-tuned models.
2. Whether 5 repetitions is sufficient for a stable CV, or whether 7–10 is needed. Determine
   empirically on the RTX 3080 and RTX 4070 Ti.
3. Whether `load_duration` is reliable enough after a forced unload to be worth reporting at all.
4. Whether Ollama reliably exposes per-layer GPU/CPU assignment in a machine-readable form, or
   whether §7's partial-offload diagnostic needs a different detection route.
5. The `num_ctx` value for W3 — 4096 is a starting assumption, not a verified saturation point.
6. Where quantized weight size comes from for §6.2 — runtime-reported vs. model metadata.

No v1.1 change closes these hardware questions.

---

## 13. Changelog

### `osai-bench/1.2` + `osai-bench-derive/1.3` — 2026-07-25 (protocol revision)

Found by an independent audit of the v1.1 implementation. All four defects passed the then-green
test suite; the fifth entry explains why.

- **W3's prompt was roughly twice its own context window.** ~29,900 characters (about 7,500-8,300
  tokens) submitted under `num_ctx: 4096`. The runtime truncated it, `prompt_eval_count` came back
  pinned at 4096, and since the validity rule compared that against an *intended* 4096 the pass
  validated. W3 would have reported five clean passes measuring a prompt it never processed in
  full — and closed the open §12.5 saturation question with a confident wrong answer. The prompt
  is now 80 repetitions (~11,960 characters), sized with headroom under `num_ctx`.
- **Added a truncation check to §5.4**, applied to every workload: `prompt_eval_count >= num_ctx`
  invalidates the pass. Comparing the count against the context window is the only way to catch
  truncation; comparing it against an expected value cannot.
- **Replaced the 5% prompt-length tolerance with an explicit band per workload.** At 32 intended
  tokens, 5% is ±1.6 — narrower than one token of tokenizer variation, so W2 and W4 would have
  failed every pass on most models and produced no generation or TTFT data. Bands are 20-64 tokens
  for W2/W4 and 2000 to `num_ctx - 1` for W3.
- **Coefficient of variation returned 0 instead of null for a single sample.** The standard
  deviation helper correctly returns null below two values, but `null / mean` coerces to 0 in
  JavaScript. A workload left with one surviving pass reported 0% run-to-run variation — perfect
  consistency — on exactly the unstable machines the metric exists to identify.
- **The test suite could not have caught any of the above.** Fixtures hardcoded
  `prompt_eval_count: 32` and `4096` — the exact values the rules wanted — so they validated by
  construction, and no test referenced the real prompt constants at all. The suite proved the code
  self-consistent while the prompts it actually sends bore no relation to the counts asserted.
  `test/prompt-sizing.test.js` now derives its expectations from the prompt constants and bounds
  tokenization across a plausible characters-per-token range, so a prompt that only works under
  one tokenizer assumption fails.

Because measurement semantics changed — a different W3 prompt and different validity rules —
`protocolVersion` moves to `osai-bench/1.2` and 1.1 records are **not** poolable with 1.2 records.
`scoringVersion` moves to `osai-bench-derive/1.3` for the CV correction. Raw measurements remain
immutable, so an existing 1.1 record can still be recomputed under the new derivation; it simply
belongs to a different measurement population.

Non-measurement changes in the same revision: model-independent run-quality preconditions are now
checked before any interactive prompt, so a refusal for battery power or GPU contention no longer
costs the user a model selection and a bandwidth entry first; the enforced conditions and the
`--quality-override` escape are unchanged. The CLI also prints an estimated run duration derived
from the scheduled pass counts before starting.


### `osai-bench-derive/1.2` — 2026-07-25 (derivation revision)

- Split the former failure rate into `passFailureRate` and `attemptFailureRate`. The pass rate
  preserves the existing scheduled-pass definition, while the attempt rate exposes transient
  §5.4 failures that later succeed on retry.
- Measurement semantics are unchanged: workloads, fixed parameters, repetitions, retry limits,
  and validity checks remain identical. `protocolVersion` therefore remains `osai-bench/1.1`,
  and records remain poolable across this derivation revision.
- Raw measured-pass attempts were already stored immutably, so every existing
  `osai-bench/1.1` record is recomputable under `osai-bench-derive/1.2`. This is the first
  production exercise of the immutable-raw design: the derivation can become more informative
  without recollecting or orphaning measurements.

### `osai-bench/1.1` — 2026-07-25

- Corrected partial CPU offload to `cpuLayers > 0 && cpuLayers < totalLayers`.
  The v1 condition inverted the intended endpoints, flagging full GPU offload and missing the
  distinction between a partial split and CPU-only execution.
- Separated repetitions for variance from retries for validity. W1 remains one measured pass but
  now receives up to two validity retries, each preceded by a forced unload. A transient invalid
  cold request should not fail without the same retry allowance as other measured passes.
- Pinned the original pass failure rate to failed measured passes divided by all scheduled
  measured passes. The workload denominator restricted the output to 25-point increments and
  discarded pass-level information.
- Pinned CV to sample standard deviation (`n - 1`). With five measured observations, this is the
  conventional estimate of run-to-run variability and prevents derivation drift.
- Investigated `/api/show` for the context-headroom diagnostic. Architecture fields are present,
  but the resolved KV-cache element type is not. The diagnostic stays unavailable and has no
  threshold because assuming bytes per element would invent a measurement.
- Added a versioned manufacturer-sourced GPU memory-bandwidth table with exact detection-name and
  VRAM matching. Manual input overrides it; absent or ambiguous matches remain unavailable.
  This makes roofline utilization available by default only where its denominator is sourced,
  without weakening the existing missing-input behavior.
- Changed the protocol identifier from `osai-bench/1` to `osai-bench/1.1`. Records from 1.0 and
  1.1 must never be pooled because retry, variance, diagnostic, and failure-rate semantics differ.
