# @opensourcesai/bench

A local LLM inference benchmark for Ollama on Windows and Linux. Version `0.4.0`
implements the draft `osai-bench/1.1` measurement protocol. Records produced
under `osai-bench/1` and `osai-bench/1.1` must never be pooled.

The package reports separate measurements. It does not create a composite
score, grade, asserted target, or “well-configured” threshold.

## Trust boundary

`@opensourcesai/bench` makes **no external network calls**. Its only HTTP
traffic is a loopback connection to the locally running Ollama API at
`http://127.0.0.1:11434`.

There is no telemetry, upload, analytics, crash reporting, version check, or
remote hardware database. The package has zero runtime dependencies. Hardware
and runtime access is confined to `src/adapters/ollama.js`; derivation modules
are pure functions and run in ordinary CI without Ollama or a GPU.

## Requirements

- Node.js 20 or newer
- Windows or Linux
- A locally running Ollama instance
- At least one installed Ollama model

The draft v1 protocol supports one discrete GPU or CPU-only execution.
Multi-GPU and Apple Silicon are out of scope.

## Run

```sh
npx @opensourcesai/bench
```

The interactive flow:

1. connects only to local Ollama;
2. checks battery/AC state, existing GPU activity, non-Ollama GPU-memory use,
   and the single-GPU requirement before asking any question;
3. lists installed models and asks you to select one;
4. checks for a different model already resident in Ollama;
5. matches the detected GPU against a bundled manufacturer-sourced memory
   bandwidth table when a sourced entry exists, otherwise offers optional
   manual entry;
6. prints a workload-count-based duration estimate;
7. runs the four protocol workloads in order;
8. prints a human-readable report; and
9. writes a JSON result in the current directory.

For automation:

```sh
npx @opensourcesai/bench \
  --model qwen3:8b \
  --memory-bandwidth 760 \
  --output qwen3-8b-result.json
```

Use `--quality-override` only for a deliberately non-standard run. The result
is permanently marked `"qualityOverride": true` and
`"cohortEligible": false`.

### Capture a real fixture

Fixture capture is opt-in and writes a second file alongside the normal result:

```sh
npx @opensourcesai/bench \
  --model qwen3:8b \
  --capture-fixture fixtures/rtx-4070-ti-partial-offload.json \
  --fixture-label "rtx-4070-ti-partial-offload"
```

`--capture-fixture <path>` and `--fixture-label <text>` must be supplied
together. The destination is created exclusively and never overwritten. A
captured file has the same `tagsResponse`, `showResponse`, and `workloads`
shape as the committed derivation fixtures, so it can be loaded without
editing. It is marked `"realHardware": true`, has no synthetic warning, and
records its free-text label, UTC capture time, client version, and protocol
version. Fixture schema `osai-bench-fixture/2` rejects the older
single-response-per-slot shape instead of silently discarding retry evidence.

Capture mode adds no network path. It uses responses already collected from
the guarded local Ollama endpoint. A normal run without `--capture-fixture`
does not build or write fixture data.

The fixture is deliberately narrower than the normal result:

- `tagsResponse` contains only the selected model's identifier, digest, byte
  size, family, parameter size, and quantization;
- `showResponse` contains only family/parameter/quantization details, the
  architecture fields needed by current derivation, and an explicit numeric
  layer assignment when Ollama provides one;
- `workloads` contains ordered scheduled slots; every slot is an array of raw
  attempt responses, each reduced by the same numeric allowlist to one final
  measurement chunk plus client-observed TTFT. Measured slots retain one to
  three attempts, while W2/W3/W4 warmup slots retain exactly one; and
- capture metadata and redaction notes occupy the remaining top-level fields.

It never writes the other installed models, prompts or request bodies, model
output, intermediate streamed chunks, Modelfile, prompt template, license,
runtime parameter text, system identity, environment, or file paths. A
path-like model identifier is replaced with `[REDACTED_LOCAL_PATH]` and the
field is listed in `redactions.pathValuesRedacted`. After writing, the CLI
prints the exact field groups and response counts captured, the absolute
destination, and every applied omission/redaction rule for review before
commit.

Before W1 begins, the CLI prints a coarse 2–10 minute planning range derived
from the 19 configured workload passes and their scheduled prompt/output token
counts. It states that hardware and retries can extend the estimate and calls
out W3 at `num_ctx = 4096` as the dominant configured work. It never reads a
prior output file or carries timing state between runs.

## Exactly what is measured

The workloads always run in this order:

| Workload | Passes | Reported measurement |
|---|---:|---|
| W1 cold load | 1 measured | Ollama `load_duration` |
| W2 short-prompt latency | 1 discarded warmup + 5 measured | Client-observed time to first streamed token |
| W3 long-prompt prefill | 1 discarded warmup + 5 measured | Ollama prompt tokens divided by `prompt_eval_duration` |
| W4 sustained generation | 1 discarded warmup + 5 measured | Ollama generated tokens divided by `eval_duration` |

Every request fixes `temperature = 0`, `seed = 42`, streaming on, and the
workload-specific `num_predict`, `num_ctx`, and `keep_alive` values. Invalid
measured passes—including W1—are retried no more than twice. Every W1 retry is
preceded by another forced unload, so it remains a cold request. A final invalid
pass makes the workload fail; failure is retained as data.

The report contains:

- median generation throughput in tokens per second;
- median long-prompt prefill throughput in tokens per second;
- median time to first token in milliseconds;
- one cold-load time in seconds;
- coefficient of variation using sample standard deviation (`n - 1`) for each
  repeated workload;
- pass failure rate: scheduled measured passes that exhausted all retries over
  the 16 scheduled measured passes;
- attempt failure rate: every measured-pass attempt failing a validity check
  over all measured-pass attempts, including retries;
- generation-only bandwidth roofline utilization when both on-disk model
  weight size and sourced or manually overridden memory bandwidth are available;
- directly detected diagnostics, or an explicit `unavailable` status; and
- the complete measurement configuration and version identifiers.

Roofline utilization applies only to generation. The theoretical ceiling
degrades with context length because KV-cache reads add memory traffic, is not
comparable across different contexts, and is unreachable in practice. It is
meaningful only for the same hardware and model. Prefill has no utilization
percentage.

No temperature or thermal data is measured.

## GPU memory-bandwidth data

Roofline utilization needs the card's published memory bandwidth. The CLI first
checks [`data/gpu-memory-bandwidth-v1.js`](data/gpu-memory-bandwidth-v1.js)
using the detection name reported by the collector and, where needed to
distinguish variants, detected VRAM. `--memory-bandwidth <GB/s>` is always a
manual override.

**The entire bundled table requires human verification before release.** Every
row carries its manufacturer, source tier, source document URL, exact locator,
dated Wayback Machine snapshot URL, and snapshot date. Values must never be
added from memory, secondary databases, retailer listings, or calculation from
plausible specifications.

New entries follow this source hierarchy: (1) architecture whitepaper,
(2) product specification page, (3) official NVIDIA technical article or
newsroom post stating the figure verbatim, or (4) omit the entry. Tier 3 is
weaker than tiers 1–2 and requires an archive snapshot; the table requires a
snapshot for every tier. If no uniquely sourced entry matches, roofline
utilization is unavailable and throughput is still reported. The CLI makes no
network request to resolve or verify the table or its archive URLs.

The initial sourced entries are:

| Detection target | Bandwidth | Tier | Manufacturer source |
|---|---:|---:|---|
| NVIDIA GeForce RTX 3080, 10 GB | 760 GB/s | 1 | NVIDIA, *NVIDIA Ampere GA102 GPU Architecture*, Table 2; [2023-06-20 snapshot](https://web.archive.org/web/20230620221827/https://www.nvidia.com/content/PDF/nvidia-ampere-ga-102-gpu-architecture-whitepaper-v2.1.pdf) |
| NVIDIA GeForce RTX 4070 Ti, 12 GB | 504 GB/s | 3 | NVIDIA, *New GeForce RTX 50 Series Graphics Cards & Laptops Powered By NVIDIA Blackwell Bring Game-Changing AI and Neural Rendering Capabilities To Gamers and Creators*, “GeForce RTX 5070 Ti: 2X Faster Than The GeForce RTX 4070 Ti,” first paragraph; [2025-01-15 snapshot](https://web.archive.org/web/20250115035359/https://www.nvidia.com/en-us/geforce/news/rtx-50-series-graphics-cards-gpu-laptop-announcements/) |

## Exactly what is written to disk

The output conforms to
[`schema/result-v1.schema.json`](schema/result-v1.schema.json) and includes:

- `protocolVersion`, `clientVersion`, and `scoringVersion`;
- UTC creation time;
- quality-override and cohort-eligibility state;
- CPU model, GPU model and VRAM, system RAM, OS/version, GPU driver, and power
  state;
- Ollama version and model identifier/family/parameter size/quantization;
- every fixed workload configuration;
- memory bandwidth value, whether it came from a manual override or the
  versioned table, and the matched entry identifier;
- raw timing counters, token counts, client TTFT, validity results, and retry
  history for each pass;
- both failure-rate numerators and denominators, not only their percentages;
- all other derived measurements and diagnostic states.

The result never contains prompts, model output, local paths, directory
contents, hostname, username, MAC address, serial numbers, conversation
history, or an installed-software inventory. Output files are created
exclusively and will not overwrite an existing file.

## Run-quality preconditions

A run is refused when the tool detects battery power, GPU utilization above
10%, more than the provisional non-Ollama GPU-memory threshold, a different
Ollama model already loaded, or multiple GPUs. Refusal messages identify the
condition. `--quality-override` preserves the run but makes it cohort
ineligible.

Battery state, GPU utilization, non-Ollama GPU-memory use, and the multi-GPU
condition are checked before the model or optional-bandwidth prompts. The
resident-model check necessarily follows model selection. If Ollama cannot be
reached at any point, the error names the exact
`http://127.0.0.1:11434` endpoint and tells the user to start Ollama and retry.

NVIDIA utilization, VRAM, driver version, and compute-process memory use
`nvidia-smi`. When it is unavailable, the collector falls back to Windows CIM
or Linux DRM sysfs for the hardware fields those interfaces expose. Missing
counters and diagnostics remain unavailable rather than being invented.

## Tests and fixtures

```sh
npm test
```

Tests cover every derivation, validity rule, retry rule, diagnostic, CLI
argument rule, result and fixture privacy boundaries, exclusive writers,
captured-fixture round trip, and loopback restriction without a GPU or Ollama.

The committed fixtures are explicitly synthetic, including the fixture that
pins a failed attempt followed by a successful retry. Real recorded Ollama
responses—including a deliberately misconfigured negative control and a
recovered retry—must replace or supplement them during RTX 3080 and RTX 4070 Ti
hardware testing before the protocol freezes or the package reaches `v1.0.0`.

## Draft-protocol limitations

The six open questions in §12 remain open. The current provisional choices are
visible next to their constants and extraction logic. In particular, Ollama
does not currently expose a standard per-layer GPU/CPU assignment in the API
responses this client consumes, so layer-based diagnostics report
`unavailable` instead of inferring layers from byte counts.

The W1/W2/W4 context values, warm `keep_alive`, and non-Ollama GPU-memory
threshold remain provisional. v1.1 pins sample-standard-deviation CV; scoring
revision `osai-bench-derive/1.2` reports both scheduled-pass failures and all
failed attempts, including recovered retries.

Ollama `/api/show` supplies model architecture metadata such as block count,
attention heads, KV heads, and embedding length, but it does not supply the
resolved KV-cache element type actually in use. That missing runtime input
prevents an authoritative KV-cache byte calculation. The context-VRAM-headroom
diagnostic therefore remains explicitly unavailable with no invented threshold.

## License

MIT
