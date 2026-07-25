# OpenSourcesAI Bench — Measurement Protocol v1.1

**Status:** DRAFT. Not frozen. Freeze at first public release (`v1.0.0`); version from there.
**Applies to:** `@opensourcesai/bench` client, protocol identifier `osai-bench/1.1`.
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
  empirically justified weights, which requires data that does not yet exist.
- **No named Efficiency or Stability score.** The underlying numbers (roofline utilization,
  run-to-run variance) are reported directly.
- **No network access of any kind.** v1 has no upload, telemetry, or version check. The only
  HTTP endpoint is the local Ollama loopback endpoint.
- **No thermal measurement.** Temperature reporting is inconsistent across vendors and
  platforms, and thermals reflect ambient conditions, case, and fan curves — not setup quality.

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
`osai-bench/1` and `osai-bench/1.1` records are distinct populations and must never be pooled.

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
The protocol does not tune the setup — it measures the setup as configured.

> **Determinism caveat.** Fixed seed and zero temperature do not guarantee identical output
> across runtime versions, quantization formats, or GPU backends. This is acceptable because
> v1 measures speed, not output equivalence. It is why §5.4 validates token counts.

### 5.2 Workloads

Four workloads, run in this order:

**W1 — Cold load.** Force unload (`keep_alive: 0` on a prior trivial request), then issue a
minimal request. Record `load_duration`. This is the only workload that measures loading;
all others run warm.

**W2 — Short-prompt latency.** Prompt of ~32 tokens. `num_predict = 128`.
Measures **time to first token** as observed wall-clock from request dispatch to first
streamed token.

**W3 — Long-prompt prefill.** Prompt of ~4096 tokens. `num_predict = 1`.
Measures prefill throughput in a regime where the GPU is actually saturated.

> **Why two prompt lengths.** Prefill is only compute-bound once the workload is large enough
> to saturate. Short-prompt prefill is dominated by launch overhead, CPU involvement, and
> runtime implementation. W2 and W3 are reported separately and must never be combined.

**W4 — Sustained generation.** Prompt of ~32 tokens. `num_predict = 512`.
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

- `eval_count` ≠ `num_predict` for W2/W4;
- `prompt_eval_count` deviates from the intended prompt length by more than 5%; or
- any duration field is zero or absent.

Each W1 retry performs another forced unload before the replacement request. This preserves
the cold-load property: W1 still contributes one measured pass, while its raw record retains
all attempts. Warmups are discarded and are not validity-retried.

Failed measured passes and workloads are recorded, not omitted.

---

## 6. Derived metrics

### 6.1 From Ollama's response fields

Ollama returns nanosecond durations and token counts:

```text
generationTokensPerSecond = eval_count        / (eval_duration        / 1e9)     # W4
prefillTokensPerSecond    = prompt_eval_count / (prompt_eval_duration / 1e9)     # W3
coldLoadSeconds           = load_duration / 1e9                                   # W1
timeToFirstTokenMs        = <client-side, W2>                                     # W2
runToRunCV                = sampleStdDev / mean, per repeated workload
sampleStdDev              = sqrt(sum((x - mean)^2) / (n - 1))
failureRate               = failed measured passes / total measured passes attempted
```

The CV uses the **sample standard deviation (`n - 1`)**. For the repeated workloads, `n = 5`.
`total_duration` is recorded but not used in a derived figure.

The failure-rate denominator is the measured-pass population, not the four workloads and not
the individual retry attempts. Under the fixed protocol, a complete run attempts 16 measured
passes: 1 for W1 and 5 each for W2/W3/W4. A pass that becomes valid on retry is not failed; a
pass still invalid after two retries is failed.

### 6.2 Roofline utilization

Single-stream autoregressive decode requires reading the full weight set per generated token,
making it memory-bandwidth-bound:

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

- Applies to **generation only**. Prefill has no bandwidth denominator.
- The ceiling degrades with context length because KV-cache reads add per-token memory traffic.
- 100% is unreachable in practice. The number is meaningful only compared against the same
  hardware and model.

### 6.3 What v1.1 reports

```text
Generation throughput          tok/s   (median of 5)
Prefill throughput             tok/s   (median of 5)
Time to first token            ms      (median of 5)
Cold load time                 s       (single measured pass)
Run-to-run variation           CV %    (sample standard deviation, per repeated workload)
Failure rate                   %       (failed measured passes / measured passes attempted)
Roofline utilization           %       (generation only, with §6.2 limits attached)
Full configuration + versions
```

No aggregate. No normalization. No letter grade.

---

## 7. Diagnostics — detected, not inferred

The client does **not** tell the user what a well-configured system "should" reach. Instead it
reports specific conditions read directly from the runtime:

| Diagnostic | Detection |
|---|---|
| Partial CPU offload | `cpuLayers > 0 && cpuLayers < totalLayers`, as reported by the runtime |
| Context exceeds comfortable VRAM headroom | Unavailable in v1.1; see below |
| CPU-only execution despite a present GPU | No GPU layers assigned while a GPU is detected |
| Quantization larger than available VRAM permits | Weight size vs. VRAM |

The partial-offload condition deliberately excludes both endpoints: zero CPU layers is full GPU
offload, while CPU layers equal to total layers is CPU-only execution and belongs to the separate
CPU-only diagnostic.

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

Not in the v1 client. Comparison proceeds down this ladder until a level qualifies, and the
level used is always displayed:

| Level | Cohort key |
|---|---|
| 1 | Exact: GPU × model × quant × context × runtime version × driver version × OS |
| 2 | Same GPU × model family × quant × runtime (major version) |
| 3 | Same GPU × approximate model size band × approximate quant band |
| 4 | **No cohort** — hardware-derived roofline only |

A percentile is shown only when both `n ≥ 10` distinct submitting accounts and interquartile
range ≤ 40% of the median. Below either threshold, results are labelled "early estimate" and
no percentile is shown. Level 4 never uses percentile language.

Runtime version is part of the cohort key and must be annotated on history views.

---

## 9. Privacy

### 9.1 Collected

CPU model · GPU model · VRAM · system RAM · OS/version · GPU driver version · runtime
name/version · model identifier/family/parameter count/quantization · context configuration ·
all measurements above · all three version identifiers.

### 9.2 Never collected

Local file paths or directory contents · conversation history · user prompts · model outputs ·
hostname, username, MAC, or serial numbers · installed software inventory · any identifier not
required to interpret a measurement.

### 9.3 Quasi-identification

The tuple `CPU + GPU + RAM + OS + driver version` is distinguishing for unusual configurations.
Any future public display requires a k-anonymity threshold independent of §8.2.

### 9.4 Consent layers

Three independent levels: local-only → private account history → anonymized inclusion in
aggregates. Consent to one is never consent to the next.

---

## 10. Client architecture constraint

The client separates, at a module boundary:

- **Collection** — one adapter per runtime. Calls the runtime and captures raw responses.
- **Derivation** — pure functions over raw measurements. Data in, data out, no hardware or
  runtime required.

Recorded real runtime responses are committed as fixtures, including a deliberately
misconfigured setup. Raw measurements are immutable and authoritative.

---

## 11. Negative control (release gate)

Before first publication, the protocol must be run against a knowingly broken configuration —
forced partial offload, oversized context, forced CPU fallback — and must be shown to produce
materially worse numbers and to fire the corresponding §7 diagnostics.

**If a badly configured machine scores well, the protocol measures nothing.** This gates freeze.

---

## 12. Open questions — resolve during hardware testing, before freeze

1. Exact prompt texts for W2/W3/W4.
2. Whether five repetitions are sufficient for stable CV on RTX 3080 and RTX 4070 Ti.
3. Whether `load_duration` is reliable enough after a forced unload.
4. Whether Ollama reliably exposes per-layer GPU/CPU assignment in a machine-readable form.
5. The W3 `num_ctx`; 4096 remains a starting assumption.
6. Whether `/api/tags` size is the correct quantized on-disk weight denominator.

No v1.1 change closes these hardware questions.

---

## 13. Changelog

### `osai-bench/1.1` — 2026-07-25

- Corrected partial CPU offload to `cpuLayers > 0 && cpuLayers < totalLayers`.
  The v1 condition inverted the intended endpoints, flagging full GPU offload and missing the
  distinction between a partial split and CPU-only execution.
- Separated repetitions for variance from retries for validity. W1 remains one measured pass but
  now receives up to two validity retries, each preceded by a forced unload. A transient invalid
  cold request should not fail without the same retry allowance as other measured passes.
- Pinned failure rate to failed measured passes divided by all measured passes attempted. The
  workload denominator restricted the output to 25-point increments and discarded pass-level
  information.
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
