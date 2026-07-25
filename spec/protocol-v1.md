# OpenSourcesAI Bench — Measurement Protocol v1

**Status:** DRAFT. Not frozen. Freeze at first public release (`v1.0.0`); version from there.
**Applies to:** `@opensourcesai/bench` client, protocol identifier `osai-bench/1`.
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
- **No network access of any kind.** v1 has no upload, no telemetry, no version check.
  An audit that finds zero outbound calls is worth more than a privacy policy.
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
Records whose `protocolVersion` differs are never pooled or compared.

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

```
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

**W2 — Short-prompt latency.** Prompt of ~32 tokens. `num_predict = 128`.
Measures **time to first token** as observed wall-clock from request dispatch to first
streamed token. This deliberately includes launch overhead, scheduling, and CPU involvement,
because that is what a user experiences.

**W3 — Long-prompt prefill.** Prompt of ~4096 tokens. `num_predict = 1`.
Measures prefill throughput in a regime where the GPU is actually saturated.

> **Why two prompt lengths.** Prefill is only compute-bound once the workload is large enough
> to saturate. Short-prompt prefill is dominated by launch overhead, CPU involvement, and
> runtime implementation. Reporting a single "prompt processing speed" silently averages two
> different physical regimes and will not be stable across runtimes. W2 and W3 are reported
> separately and must never be combined.

**W4 — Sustained generation.** Prompt of ~32 tokens. `num_predict = 512`.
Measures generation throughput, the primary bandwidth-bound metric.

### 5.3 Warmup and repetitions

- W1 runs **once** (repeating it requires repeated unload; cold-load variance is out of scope for v1).
- W2, W3, W4 each run **1 warmup pass (discarded) + 5 measured passes**.
- Report **median** as the headline figure and **coefficient of variation** across the 5 as
  the consistency figure. Median resists the single-outlier case; CV is the honest variance signal.

### 5.4 Validity checks

Each measured pass is invalid, and must be retried up to 2 times before the workload is
marked failed, when:

- `eval_count` ≠ `num_predict` for W2/W4 — the model emitted EOS early, so `eval_duration`
  covers fewer tokens than intended and is not comparable. **Prompts for W2 and W4 must be
  chosen to elicit long continuations** to make this rare; the check exists because it cannot
  be prevented outright.
- `prompt_eval_count` deviates from the intended prompt length by more than 5% — tokenizer
  differences between models are expected and are recorded, but a large deviation indicates
  prompt truncation against `num_ctx`.
- Any duration field is zero or absent.

Failed workloads are recorded as failures, not omitted. Failure rate is a reported metric.

---

## 6. Derived metrics

### 6.1 From Ollama's response fields

Ollama returns nanosecond durations and token counts, so throughput is computed from the
runtime's own accounting rather than from client-side wall-clock:

```
generationTokensPerSecond = eval_count        / (eval_duration        / 1e9)     # W4
prefillTokensPerSecond    = prompt_eval_count / (prompt_eval_duration / 1e9)     # W3
coldLoadSeconds           = load_duration / 1e9                                   # W1
timeToFirstTokenMs        = <client-side, W2>                                     # W2
runToRunCV                = stddev / mean, per workload, across the 5 measured passes
```

`total_duration` is recorded but not used in any derived figure — it includes overheads the
other fields already partition.

### 6.2 Roofline utilization

Single-stream autoregressive decode requires reading the full weight set per generated token,
making it memory-bandwidth-bound. This yields a theoretical ceiling computable from hardware
specs alone, with no dataset:

```
theoreticalMaxTokensPerSecond = memoryBandwidthGBps / modelWeightsGB
rooflineUtilization           = generationTokensPerSecond / theoreticalMaxTokensPerSecond
```

`modelWeightsGB` is the **quantized on-disk weight size**, not a figure derived from
parameter count.

**Stated limits — these must appear wherever the number is displayed:**

- Applies to **generation only**. Prefill is compute-bound at scale and has no bandwidth
  denominator. There is no TFLOPs figure in the hardware data, so v1 reports prefill
  throughput as a bare number with no utilization percentage.
- The ceiling **degrades with context length**, because KV cache reads add to per-token
  memory traffic. v1 fixes context per workload so figures are comparable to each other;
  the ceiling is not valid across different context sizes.
- 100% is unreachable in practice. The number is only meaningful compared against the same
  hardware and model, which is why §8 governs how it may be presented.

### 6.3 What v1 reports

```
Generation throughput          tok/s   (median of 5)
Prefill throughput             tok/s   (median of 5)
Time to first token            ms      (median of 5)
Cold load time                 s       (single)
Run-to-run variation           CV %    (per workload)
Failure rate                   %
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
| Partial CPU offload | Layers assigned to CPU < total layers, as reported by the runtime |
| Context exceeds comfortable VRAM headroom | Configured `num_ctx` vs. free VRAM at load |
| CPU-only execution despite a present GPU | No GPU layers assigned while a GPU is detected |
| Quantization larger than available VRAM permits | Weight size vs. VRAM |

A report reading *"61% of bandwidth ceiling; 7 of 33 layers on CPU"* is more useful and more
defensible than any percentage target, and it holds at n=1.

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
