# OpenSourcesAI Bench — Measurement Protocol v1.3

**Status:** DRAFT. Not frozen. Freeze at first public release (`v1.0.0`); version from there.
**Applies to:** `@opensourcesai/bench` client, protocol identifier `osai-bench/1.3`.
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
because that is what a user experiences. The first streamed token is the first token in *either*
output channel: a reasoning model streams its chain-of-thought into a separate `thinking` field
while the visible `response` field stays empty, and that first thinking token is when decode
begins — which is what launch-plus-prefill latency measures. Keying only on the visible channel
reported TTFT as unavailable on qwen3:8b, whose entire W2 budget was spent in the thinking
channel; see §12.1 and the 0.7.0 changelog.

**W3 — Long-prompt prefill.** Long prompt, accepted band 2000 tokens to `num_ctx - 1`.
`num_predict = 1`. Measures prefill throughput in a regime where the GPU is actually saturated.
Every call — the warmup and every attempt of every measured pass, including retries — sends a
distinct prompt: a short deterministic marker unique to that call is prepended to the base
prompt (§5.2.1). The base prompt content itself is fixed and unchanged by this.

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

### 5.2.1 Defeating runtime prompt-prefix caching (W3 only)

Discovered on the first real hardware run (protocol 1.2, RTX 4070 Ti, llama3.1:8b, Ollama
0.32.3). W3 sent the identical prompt on the warmup and all five measured passes while the
model stayed resident (`keep_alive: "5m"`). Ollama's runner reused the previous call's KV state
for the shared prefix: `prompt_eval_count` still reported ~2,650, but `prompt_eval_duration`
collapsed to ~13ms — not on one or two passes, on **all five** — reporting a prefill throughput
of ~208,000 tok/s. That is the cost of a cache lookup, not a measurement, and it meant §12.5
remained unanswered by a run that appeared to complete cleanly.

**The fix:** every W3 call — warmup and every attempt of every measured pass, including
retries — is prepended with a short marker unique to that call, of the form
`[osai-bench cache-bust w3#<n>]`, where `<n>` increments once per call in a fixed, deterministic
sequence. This guarantees the prefix diverges from token 0 on every request, defeating prefix
reuse regardless of the runtime's internal caching implementation. The base prompt content is
untouched; only a few tokens are added, well inside the accepted band's headroom. Because the
marker is a pure function of `(workload id, call index)`, and the call sequence is itself fixed
by the protocol, the exact text of any call is fully reconstructible without a raw-record
schema change.

**Considered and rejected:** setting `keep_alive: 0` per call, which does defeat the cache — by
forcing a full model reload. That is exactly what W1 already does deliberately, and this
document is explicit that W1 is the only workload that measures loading. Applying it to W3
would fold multi-second reload time into every prefill pass, replacing one contamination
(a cache hit) with a worse one (model-load time misattributed to prefill).

**Scoped to W3 only.** W1 already forces an unload before every attempt, so it was never
affected. W4's generation throughput reads through the KV cache regardless of how the prompt
entered it, so decode measurements are unaffected. W2's time-to-first-token is dominated by
launch overhead by design (§5.2), so a cache hit on its short prompt would shave a negligible
amount off an already-small prefill component; W2 and W4 continue to send their prompt
unmodified.

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
**materially worse throughput** than a baseline run on the same hardware and model.

**If a badly configured machine scores well, the protocol measures nothing.** This is the
single cheapest test that validates the entire premise, and it gates the freeze.

**Throughput is the binding criterion; diagnostics firing is not.** Earlier wording required
the control to *also* fire the corresponding §7 diagnostics. That is unsatisfiable on runtimes
that do not expose the underlying facts: Ollama 0.32.3 reports no machine-readable per-layer
GPU/CPU assignment, so `partial-cpu-offload` and `cpu-only-with-gpu` correctly report
`unavailable` even on a deliberately broken configuration. Requiring them would make the gate
permanently unpassable on the only runtime v1 supports, which in practice means it would be
quietly waived — the worst outcome for a release condition. Where a runtime *does* expose the
facts, the diagnostics must fire, and failing to do so is a defect.

### 11.1 Result — 2026-07-25, RTX 4070 Ti, llama3.1:8b Q4_K_M, Ollama 0.32.3

**PASSED.** Baseline against a control with `num_gpu 8` (~8 of 33 layers resident):

| Metric | Baseline | Broken | Change |
|---|---|---|---|
| Generation throughput | 82.14 tok/s | 16.14 tok/s | **5.1× slower** |
| Prefill throughput | 5,698.83 tok/s | 1,902.04 tok/s | 3.0× slower |
| Time to first token | 217.12 ms | 286.20 ms | 32% worse |
| Roofline utilization | 80.20% | 15.76% | −64 points |

Both runs completed with 0/16 pass failures and 0/16 attempt failures, so the difference is
signal rather than degraded data quality. The magnitude is physically coherent: with ~25 of 33
layers evicted to system RAM, most weight reads move from GDDR6X (504 GB/s) to DDR5 (~80-100
GB/s), and a ~5× decode slowdown is the expected consequence. Roofline utilization collapsing
to 15.76% demonstrates the bandwidth-ceiling metric surfacing a misconfiguration without any
cohort data — its intended purpose.

As anticipated above, all three layer-assignment diagnostics reported `unavailable` in both
runs; the gate rests on the throughput evidence.

### 11.2 Result — 2026-07-26, RTX 3080, llama3.1:8b Q4_K_M, Ollama 0.30.10

**PASSED.** Same `num_gpu 8` control as §11.1 (~8 of 33 layers resident), a second GPU:

| Metric | Baseline | Broken | Change |
|---|---|---|---|
| Generation throughput | 117.03 tok/s | 8.76 tok/s | **13.4× slower** |
| Prefill throughput | 4,503.26 tok/s | 711.21 tok/s | 6.3× slower |
| Time to first token | 171.38 ms | 290.79 ms | 70% worse |
| Roofline utilization | 75.77% | 5.67% | −70.1 points |

Both runs completed with 0/16 pass failures and 0/16 attempt failures. The collapse is larger here
than on the 4070 Ti (5.1×, −64 points), and in the expected direction: the 3080's higher memory
bandwidth (760 GB/s vs. the 4070 Ti's 504 GB/s) means a larger relative penalty when layers evict
to the same class of system DDR5 — a faster GPU has further to fall. All three layer-assignment
diagnostics again reported `unavailable`, on a different Ollama version (0.30.10 vs. 0.32.3) and a
different GPU vendor generation, reinforcing that this is a runtime limitation rather than a quirk
of one card.

This closes the RTX 3080 portion of §12's re-run requirement for the negative control and items
2–4. Items 1, 5, and 6 are unrelated to which GPU is underneath and remain open regardless.

### 11.3 Result — 2026-07-26, oversized context, two GPUs, llama3.1:8b Q4_K_M

**PASSED, with a finding more precise than "oversized context is always worse."**

**Mechanism note.** Unlike `num_gpu`, `num_ctx` cannot be forced via a Modelfile — §5.1 fixes it
as a protocol constant the client sends explicitly on every call, which always overrides a
Modelfile default. This control instead temporarily edited `WORKLOADS.w2/w3/w4.numCtx` in
`src/protocol.js` from 4096 to 32768 (leaving w1 untouched), ran once, and reverted before any
commit. Reproducing this control requires the same temporary edit, not a Modelfile.

| Metric | RTX 3080 baseline → 32768 | RTX 4070 Ti baseline → 32768 |
|---|---|---|
| Generation throughput | 116.99 → 74.44 tok/s (**−36.4%**) | 82.14 → 87.61 tok/s (**+6.7%**) |
| Prefill throughput | 4,505.69 → 3,677.57 tok/s (−18.4%) | 5,698.83 → 5,967.82 tok/s (+4.7%) |
| Time to first token | 169.55 → 179.81 ms (+6.1%) | 217.12 → 251.04 ms (**+15.6%**) |
| Roofline utilization | 75.75% → 48.19% | 80.20% → 85.54% |
| Free VRAM at this `num_ctx` | ~1.1 GB (10 GB card) | ~3.1 GB (12 GB card) |

The 4070 Ti did not degrade — generation and prefill both moved slightly *up*, within the range
of ordinary run-to-run variance, and roofline utilization tracked generation exactly (both
computed against the same 102.42 tok/s ceiling, confirming the ceiling itself is correctly
unaffected by context size). The 3080 degraded substantially.

**What is consistent across both cards: time to first token got worse on both** (+6.1% and
+15.6%). Allocating a much larger KV cache buffer before the first token costs real, universal
setup latency. **What is not consistent: steady-state throughput.** It degraded only on the card
with little free VRAM at that context size, and held flat on the card with several gigabytes to
spare. That is more informative than a uniform result would have been: it points at VRAM
pressure, not context size per se, as the operative variable — the danger is specifically an
oversized context that doesn't comfortably fit alongside the model, not large context in the
abstract.

**Confound, stated plainly.** The two machines also differ in Ollama version (0.30.10 vs.
0.32.3) and OS, and those differences correlate with which card ran which test — this evidence
cannot fully separate "VRAM headroom" from "Ollama version" as the explanatory variable. The
headroom explanation is the physically motivated leading hypothesis, not a settled one; isolating
it needs a test holding one variable fixed while varying the other.

**Second confound, found after this run and material to the conclusion above (§8.4).** The two
machines were not running the same KV-cache configuration: the 4070 Ti box sets
`OLLAMA_KV_CACHE_TYPE=q8_0` and `OLLAMA_FLASH_ATTENTION=true`, the 3080 rig sets neither and
runs f16. At the `num_ctx` this control uses, that is not a rounding difference — it is the
whole effect being measured:

| KV cache, llama3.1:8b at `num_ctx` 32768 | Allocation |
|---|---|
| 3080 rig — f16 | **4.295 GB** |
| 4070 Ti — q8_0 | **2.282 GB** |
| Difference | **2.013 GB** |

The free-VRAM gap this section reports as evidence for the headroom hypothesis — ~1.1 GB against
~3.1 GB, a gap of roughly 2.0 GB — is the same magnitude as the KV-cache-type difference alone.
The 4070 Ti had headroom substantially *because it was quantizing its KV cache*, not only because
it is a 12 GB card. Headroom and KV cache type are entangled here and this run cannot separate
them.

This does not overturn the finding, and it does not touch the cross-card TTFT result, which held
in the same direction on both machines. It narrows what may be claimed: **the operative variable
is VRAM pressure at the tested context, and this pair of runs cannot attribute that pressure
between card capacity, KV cache element type, and Ollama version.** A decisive test holds KV
cache type and Ollama version fixed and varies only free VRAM. Runs from client 0.8.0 onward
record `runtime.environment`, so a repeat of this control will carry the KV setting in the
result envelope rather than requiring it to be reconstructed from server logs afterwards.

Both runs on both cards completed 0/16 pass and 0/16 attempt failures — every reported difference
is signal, not degraded data quality.

### 11.4 Result — 2026-07-26, RTX 3080, forced CPU fallback (`num_gpu 0`), llama3.1:8b Q4_K_M, Ollama 0.30.10

**PASSED, decisively — the largest collapse of any §11 scenario, and asymmetric in exactly the
way §5.2 predicts.**

| Metric | Baseline | CPU-only | Change |
|---|---|---|---|
| Generation throughput | 116.99 tok/s | 6.15 tok/s | **19.0× slower** |
| Prefill throughput | 4,505.69 tok/s | 70.40 tok/s | **64.0× slower** |
| Time to first token | 169.55 ms | 338.03 ms | 2.0× slower |
| Roofline utilization | 75.75% | 3.98% | −71.8 points |

Prefill collapsed roughly 3.4× harder than generation (64× vs. 19×). §5.2 states prefill is
compute-bound and generation is bandwidth-bound; a CPU's raw matrix-multiply throughput lags a
GPU's far more than its memory bandwidth does relative to GDDR6X, so this asymmetry is exactly
the physical signature that design rationale predicts. This is the cleanest empirical
confirmation yet that the protocol's two-metric split is measuring the two distinct regimes it
claims to.

Both runs completed 0/16 pass and 0/16 attempt failures. All three layer-assignment diagnostics
again reported `unavailable`, on the third distinct broken configuration to hit that Ollama
limitation — fully consistent with §12.4 and the §11 preamble's rationale for resting the gate
on throughput alone.

**All three named §11 scenarios — forced partial offload, oversized context, forced CPU
fallback — now have real-hardware evidence.** Partial offload and CPU fallback both pass
unconditionally on every card tested. Oversized context passes with a more precise finding
than originally anticipated: its effect on throughput is conditional on available headroom,
not universal, while its effect on time-to-first-token is universal. Nothing here is a gap
against the gate's own wording; the nuance is additional signal, not a shortfall.

---

## 12. Open questions — resolve during hardware testing, before freeze

Status after the 2026-07-25 RTX 4070 Ti hardware session. Every per-item figure below is measured
on that one machine and model. A second GPU has since been checked for the negative control and
for items 2–4 (§11.2, RTX 3080, 2026-07-26) — a second model family is still required before the
freeze (item 1), along with items 5 and 6.

1. **Answered — a second model family confirms the prompts hold.** The W2/W3/W4 prompt texts are
   license-clean originals, sized (§5.2) so their token counts land inside each band across
   tokenizers. Re-measured with `scripts/diagnose-prompts.js`: llama3.1:8b gives W2/W4 = 45,
   W3 = 2,664 (6.73 characters per token); qwen3:8b — a genuinely independent family with a
   different tokenizer (~151k vocab against llama3.1's 128k) — gives W2/W4 = 49, W3 = 2,796
   (6.41 chars/token); and phi3-mini — a much smaller 32k-vocab tokenizer (Llama-2 lineage),
   chosen to stress the bands from the opposite direction — gives W2/W4 = 51, W3 = 3,276 (5.47
   chars/token). All four bands hold on all three: each clears the W3 2,000-token floor and, at
   the least-efficient end, phi3's 3,276-token W3 still keeps 20% headroom under `num_ctx`. The
   120-repetition sizing absorbs the full 5.47–6.73 char-per-token spread these tokenizers
   produce on that text (a 32k→151k vocab span), so the fixed prompts are not tuned to one
   tokenizer. A full qwen3:8b run (RTX 3080, Ollama 0.30.10) completed 0/16 pass failures, so
   W2/W4 did not early-EOS on a second family's generation either. That run also surfaced and
   fixed the thinking-channel TTFT defect (0.7.0 changelog): qwen3:8b's TTFT now reads 162 ms
   against llama3.1's 171 ms on the same GPU. (phi3-mini's band check is a prefill-only
   token-count probe; it was not run as a full generation capture because its F16 weights plus a
   4,096-token KV cache do not leave clean headroom on a 10 GB card, which would risk a silent
   partial offload rather than a clean baseline.)
2. **Answered — 5 repetitions is sufficient.** Observed CVs: generation 0.57% / 0.05%, prefill
   0.15% / 0.07%, TTFT 0.71% / 2.21% across the baseline and negative-control runs. Variance at
   that level is far below anything 7–10 repetitions would meaningfully tighten. Retain 5.
3. **Answered — `load_duration` is reliable.** 2.83 s and 3.06 s across two runs on the same
   model, after a forced unload each time. Consistent and worth reporting.
4. **Answered — Ollama does not expose it.** No machine-readable per-layer GPU/CPU assignment in
   `/api/show` or `/api/ps` on 0.32.3. `partial-cpu-offload` and `cpu-only-with-gpu` correctly
   report `unavailable`, including on a deliberately partial-offload configuration. §7 needs a
   different detection route, or the diagnostics stay runtime-contingent. This is why §11 no
   longer requires diagnostics to fire.
5. **Answered — W3 sits on the prefill plateau.** `scripts/sweep-prefill-saturation.js` sweeps
   prompt length from ~200 to ~7,000 tokens (RTX 3080, num_ctx 8192, unique prompt per call).
   Prefill throughput rises steeply off a fixed-overhead floor, reaches 95% of its ceiling by
   only ~380 tokens, and holds a broad plateau before a gentle decline past ~4,000 tokens as
   attention cost grows. W3's operating point is on that plateau on both families measured:
   llama3.1:8b 4,620 tok/s at 2,662 tokens = **98.2%** of its ceiling; qwen3:8b 4,457 tok/s at
   2,797 tokens = **98.5%**. So W3 reports the saturation-bound prefill rate, not a length-sensitive
   point on a rising curve, and the 2,000-token band floor (set for tokenizer robustness, §12.1)
   sits well inside the saturated regime. Measured on one GPU; the mechanism is not GPU-specific
   but the exact plateau shape is hardware-dependent.
6. **Answered — `/api/tags` size is genuine weight bytes.** `scripts/verify-weight-size.js`
   compares that size against the model's manifest layers and against the model blob parsed
   directly as GGUF (tensor-data region = everything after the header, metadata, and tensor
   table). Two levels agree: the non-weight manifest layers (template, license, params, config)
   are ~14 KB, and the GGUF's non-tensor bytes are the header plus metadata — dominated by the
   embedded tokenizer vocabulary. Genuine weight tensor bytes as a fraction of `/api/tags` size:
   llama3.1:8b Q4_K_M (128k vocab) **99.840%**, qwen3:8b Q4_K_M (151k vocab) **99.886%**, phi3-mini
   F16 (32k vocab) **99.990%**. The denominator therefore slightly *over*states weight bytes (by
   the vocab-heavy metadata), pushing roofline utilization at most ~0.16% low — negligible, and
   the opposite direction from a bug that would flatter a system. The "substantial non-weight
   overhead" worry is disproven.

**Remaining before freeze:** none of the original §12 questions. Items 1–6 are answered: the
prompts hold across three tokenizer families spanning 32k–151k vocab (§12.1), W3 is
saturation-bound (§12.5), and the roofline denominator is genuine weight bytes (§12.6). The RTX
3080 re-run (§11.2) confirms the negative control and items 2–4 are not GPU-specific. What
remains before freeze is breadth, not open questions — more GPUs and model families in the
fixture set — and any protocol gaps still marked provisional in the sections above (e.g. the §4
contention threshold, the §12.4 layer-assignment detection route).

---

## 13. Changelog

### `clientVersion` 0.7.0 — 2026-07-26 (client fix; second model family added)

Found on the first run of a second model family — qwen3:8b (RTX 3080, Ollama 0.30.10), added to
close §12.1's requirement that the fixed prompts hold on a second, genuinely different tokenizer.
They do: all four bands are satisfied (W2/W4 = 49 tokens, W3 = 2,796) and the run completed 0/16
pass failures. But one metric came back wrong.

- **Time to first token was reported `unavailable` for a reasoning model.** §5.2 defines TTFT as
  the time to the first *streamed token*, but the collector started its clock only on the first
  non-empty `response` chunk. qwen3:8b is a thinking-by-default model: on W2 (`num_predict = 128`)
  it spent the whole budget in Ollama's separate `thinking` channel — 128 generated tokens,
  `response` empty on every one — so the clock never started and TTFT came back unavailable, even
  though generation throughput and every validity check were unaffected (they read Ollama's own
  token counters, which count thinking tokens). Confirmed by a direct `/api/generate` probe:
  `response` length 0, `thinking` length 542, `done_reason: length`.
- **Fix:** the first-token clock now starts on the first streamed token in *either* channel
  (`response` or `thinking`). For a non-thinking model this is byte-identical to prior behavior —
  its first streamed token is a `response` token — and for a reasoning model it captures the true
  first-token latency the metric was always defined to measure.

This corrects the implementation to match §5.2's existing "first streamed token" definition rather
than changing that definition, so nothing previously reported as a valid measurement changes:
non-thinking runs are identical, and thinking runs move from a wrong `null` to a real number. The
protocol contract is unchanged — `protocolVersion` stays `osai-bench/1.3` and `scoringVersion`
stays `osai-bench-derive/1.3`; only `clientVersion` moves to 0.7.0. Fixtures captured before 0.7.0
remain valid; a thinking-model fixture captured earlier carries a `null` TTFT and should be
re-captured to populate it.

### `osai-bench/1.3` — 2026-07-25 (protocol revision, first real-hardware run)

Found on the first real hardware session (RTX 4070 Ti, llama3.1:8b, Ollama 0.32.3), after the
1.2 sizing fix let W3 pass its validity band for the first time.

- **W3's identical repeated prompt let the runtime reuse KV state across calls.** All five
  measured passes — not a subset — collapsed to ~13ms `prompt_eval_duration` against a
  `prompt_eval_count` that still read ~2,650, reporting ~208,000 tok/s prefill throughput. §12.5
  remains open: this run measured a cache lookup, not prefill. See §5.2.1 for the full account
  and the considered-and-rejected `keep_alive: 0` alternative.
- **Fix:** every W3 call — warmup and every attempt including retries — is prepended with a
  short marker unique to that call, guaranteeing the prefix diverges from token 0 regardless of
  the runtime's caching implementation. Scoped to W3 only; §5.2.1 explains why W1/W2/W4 are
  unaffected and unchanged.
- **Also fixed, same session:** a single-sample GPU-utilization precondition check produced two
  false refusals (25%, then 32%) on an idle desktop within seconds of each other, then succeeded
  with nothing closed — `nvidia-smi`'s utilization figure is a rolling, bursty measure, and one
  of dozens of ordinary GPU-accelerated desktop apps redrawing during a single sample window was
  enough to trip the §4 threshold. The collector now takes three samples ~200ms apart and uses
  the median; a real competing workload still refuses correctly across all three.
- **Also fixed:** `writeResult` and `writeFixtureCapture` did not create their output directory,
  so a completed run's JSON was silently discarded with `ENOENT` if the target folder did not
  already exist — observed directly on the first run. Both now create the parent directory
  before writing; the no-overwrite guarantee is unchanged.

Measurement semantics changed (a different effective prompt is sent for W3), so `protocolVersion`
moves to `osai-bench/1.3`; 1.2 records are not poolable with 1.3 records. No derivation formula
changed, so `scoringVersion` stays at `osai-bench-derive/1.3`. `clientVersion` 0.6.0.

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
