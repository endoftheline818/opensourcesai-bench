# OpenSourcesAI Bench — v1 coverage matrix

Companion to [`protocol-v1.md`](protocol-v1.md). The protocol's §3 says what is **in scope**.
This document says what has actually been **validated**, which is a narrower thing, and names the
gap between them.

The distinction is the entire point. "Ollama on Windows and Linux, one discrete GPU" is a support
statement. It is not evidence that any particular GPU, model, quantization or Ollama version has
ever produced a clean run. Where evidence exists, this document points at it; where it does not,
it says so rather than letting scope be read as coverage.

**Status: draft, tracking issue #17.** It is a record of validation, not a promise of support, and
it changes whenever a fixture or a first-party run is added.

---

## 1. Scope, restated

| Axis | v1 support (§3) |
|---|---|
| Runtime | Ollama only |
| OS | Windows, Linux |
| Accelerator | Single discrete GPU, or CPU-only (labelled) |
| Model | Any Ollama-pullable model the user selects |

Multi-GPU, Apple Silicon and every other runtime are **out of scope**, not merely untested. §10's
adapter boundary is shaped to accept another runtime without a protocol revision; nothing else on
this list is a matter of effort alone.

---

## 2. Evidence classes

Coverage claims here are one of four things, and they are not interchangeable:

| Class | Means |
|---|---|
| **Fixture** | A real captured run is committed under `fixtures/`, so every derivation rule, diagnostic and gate is replayable in CI with no hardware present (§10). The strongest class. |
| **First-party run** | A complete run was performed on a machine this project controls, and its figures are recorded in the spec or an issue, but no fixture was committed. |
| **Probe** | A partial measurement — a prompt token count, a placement reading — not a full protocol run. |
| **Untested** | In scope, no evidence. |

---

## 3. Operating systems and runtime

| OS | Class | Evidence |
|---|---|---|
| Linux (Ubuntu 26.04, x64) | **Fixture** | Five of the seven committed real-hardware fixtures |
| Windows (x64) | **Fixture** | Two committed real-hardware fixtures; first-party interactive runs including a §4 refusal |
| macOS | **Out of scope** | Refused since client 0.13.0 (§3, §4). Before that a macOS run completed and reported `cohortEligible: true` with the GPU undetected — indistinguishable, in every field a consumer keys on, from a protocol-grade run |

**Ollama versions exercised:** 0.30.10, 0.32.3, 0.32.5, 0.32.15. No version floor is declared and
none is enforced: the client reads `/api/version` and records it, and since the fixture runtime
capture landed, a fixture records it too. **Records whose runtime version differs are not
comparable without consulting §8.3 and §8.4** — an unremarkable-looking version bump has already
been shown to be the wrong explanation for a difference that was really model-attributable.

**Node.js:** `engines` requires ≥ 20. CI runs the suite on 20, 22 and 24 across `ubuntu-latest`
and `windows-latest` — six combinations on every push.

---

## 4. Accelerators

| Device | Class | What it evidences |
|---|---|---|
| **NVIDIA RTX 3080, 10 GB** (Linux) | **Fixture** ×5 | The baseline, the second model family, and three of the four §11 negative controls — forced partial offload, forced CPU fallback, oversized context |
| **NVIDIA RTX 4070 Ti, 12 GB** (Windows) | **Fixture** ×2 | The original §11.1 negative control and an oversized-context control; the second GPU that showed items 2–4 are not GPU-specific |
| **CPU-only, no GPU** (Linux, Raspberry Pi 4B 8 GB) | **First-party run** | The only evidence for the CPU-only accelerator row. A clean run — 0.00% pass failure, CV under 1.3% — plus the four-run investigation behind issue #25. No fixture committed |
| Every other NVIDIA GPU | **Untested** | Covered by the bundled bandwidth table only insofar as an entry exists; an entry is a manufacturer-sourced number, not a run |
| AMD, Intel Arc | **Untested** | In scope under §3 in principle. Every §4 precondition is `nvidia-smi`-based, so on such a machine the conditions fall back to display-adapter enumeration and the run is not quality-assured to the same standard |

> **The AMD/Intel gap is the sharpest hardware gap in v1.** §3 admits "single discrete GPU"
> without qualification, but the machinery that vouches for a run is NVIDIA-specific. That is not
> the same failure the §3 OS row had — a GPU-less Windows or Linux box is correctly labelled
> CPU-only — but it has the same shape, and it has not been examined on hardware.

---

## 5. Models

Every committed real-hardware fixture is **Q4_K_M**, and all seven were captured on the same day
(2026-07-26). Two model families are represented; three of the seven are Modelfile variants of one
of them, built deliberately broken for the §11 controls.

| Model | Quant | Class | Notes |
|---|---|---|---|
| `llama3.1:8b` | Q4_K_M | **Fixture** | The baseline. 128k-vocab tokenizer |
| `qwen3:8b` | Q4_K_M | **Fixture** | Second family, ~151k vocab. Thinking-by-default, which is how the §5.2 TTFT channel defect was found |
| `llama3.1-8b-broken`, `llama3.1-8b-cpuonly` | Q4_K_M | **Fixture** | §11 negative controls, not models a user would select |
| `qwen3:4b` | Q4_K_M | **First-party run** | Windows capture box, including the first in-the-wild §4 refusal |
| `qwen3:4b-fp16` | F16 | **First-party run** | The only full run outside Q4_K_M |
| `llama3.2:1b-instruct-q4_K_M` | Q4_K_M | **First-party run** | The CPU-only clean run |
| `phi3-mini` | F16 | **Probe** | Prompt token counts only. Its F16 weights plus a 4,096-token KV cache leave no clean headroom on a 10 GB card, so a full capture would risk a silent partial offload rather than a clean baseline |

### 5.1 Models known not to satisfy the protocol

Recorded in §12.1a of the protocol, and **refused at the start of a run** since the §4 prompt-band
check landed, rather than discovered after the full protocol has run:

| Model | Why |
|---|---|
| `qwen2.5:7b-instruct-q8_0` | 68 prompt tokens against the W2/W4 ceiling of 64 |
| `tinyllama:latest` | 76 against that ceiling, and 1,026 against W3's 2,000 floor — its real trained context is 2,048 |
| `laguna-xs-2.1:latest` | 81 against the same ceiling. Locally built, listed because it is real evidence, not because it is a model anyone else has |
| `phi3:3.8b-mini-128k-instruct-fp16` | Stops generating at exactly 107 tokens under both a 128- and a 512-token budget. **Not caught by the §4 check** — early EOS is only observable by generating |

These are not defects to be fixed by widening a band. They are the measured boundary of what the
fixed prompts fit, and the freeze decision has to be taken against them.

---

## 6. Quantization

| Quantization | Class |
|---|---|
| Q4_K_M | **Fixture** |
| F16 | **First-party run** (`qwen3:4b-fp16`) and **probe** (phi3-mini) |
| Q8_0 | **Refused** — the only q8_0 model reached so far misses the W2/W4 band |
| Q4_0, Q5_*, Q6_K, Q3_*, AWQ/GPTQ-derived tags | **Untested** |

Quantization enters the protocol in one load-bearing place: the roofline denominator is on-disk
weight bytes (§6.2, §12.6), verified as genuine weight bytes across a 32k–151k vocabulary span at
Q4_K_M and F16. Nothing about that verification is quantization-specific in principle, and nothing
has confirmed it outside those two.

---

## 7. Launch test set

The minimum that should be re-run and seen clean before a release, chosen so that each entry
covers something no other entry does:

| # | Configuration | Covers |
|---|---|---|
| 1 | RTX 3080 / Linux / `llama3.1:8b` Q4_K_M | The baseline; compares directly against the committed fixture |
| 2 | RTX 3080 / Linux / `qwen3:8b` Q4_K_M | Second tokenizer family; the thinking-channel TTFT path |
| 3 | RTX 4070 Ti / Windows / `llama3.1:8b` Q4_K_M | The other OS, the other GPU, and the §8.4 environment declaration, which differs between the two capture machines |
| 4 | Either GPU / forced `num_gpu 0` | §11's CPU-fallback control: must score materially worse **and** fire its diagnostic |
| 5 | Either GPU / forced partial offload | §11's partial-offload control, same two criteria |
| 6 | Either GPU / `num_ctx` 32768 | §11's oversized-context control |
| 7 | CPU-only Linux / a small model with adequate context | The CPU-only accelerator row |
| 8 | Any machine / `qwen2.5:7b-instruct-q8_0` | The §4 prompt-band refusal, including that it refuses in seconds and unloads the model |
| 9 | macOS, any | §3's OS row: must refuse, and must say so followably |

1–7 are measurements. 8 and 9 are refusals, and belong on the list for the same reason the §11
controls do: a gate that has never been seen to fire is not known to work.

---

## 8. Gaps, in the order they matter

1. **The prompt bands do not fit every model (§12.1a).** Open, blocking the freeze, and the only
   item on this list that is a protocol question rather than a coverage question.
2. **One quantization family in fixtures.** Q4_K_M is the common case, and it is also the only case
   any committed fixture can replay.
3. **AMD and Intel GPUs are in scope with no evidence and NVIDIA-specific preconditions.**
4. **CPU-only rests on first-party runs with no committed fixture**, so nothing in CI replays it.
5. **All seven real fixtures were captured on one day, on clients 0.6.0–0.7.0**, and predate both
   the `/api/ps` placement capture and the runtime-version capture. They remain valid — absent
   fields degrade rather than invalidate — but none can say which Ollama version produced it.
6. **No fixture exists for a refusal.** Refusals happen before measurement, so there is nothing for
   the capture path to write; entries 8 and 9 of the launch test set are consequently manual.

---

## 9. Extending this

Coverage grows by capturing, not by asserting. A new device or model family becomes a **fixture**
class entry by running with `--capture-fixture`, reviewing exactly what the CLI prints it captured,
and opening a PR with the fixture and a row here. A run that cannot be captured — because the
machine is not one this project controls, or because the run was a refusal — can still be recorded
as a **first-party run** with its figures, and is worth strictly less.

Nothing in this document may be used to imply that an untested configuration is expected to work,
or that a validated one is expected to reach any particular number. Neither claim is a measurement.
