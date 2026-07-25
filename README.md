# @opensourcesai/bench

A local LLM inference benchmark for Ollama on Windows and Linux. Version `0.1.0`
implements the draft `osai-bench/1` measurement protocol.

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
2. lists installed models and asks you to select one;
3. optionally asks for the GPU's published memory bandwidth, used only for the
   generation roofline calculation;
4. checks run-quality preconditions;
5. runs the four protocol workloads in order;
6. prints a human-readable report; and
7. writes a JSON result in the current directory.

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
measured passes are retried no more than twice. A final invalid pass makes the
workload fail; failure is retained as data.

The report contains:

- median generation throughput in tokens per second;
- median long-prompt prefill throughput in tokens per second;
- median time to first token in milliseconds;
- one cold-load time in seconds;
- coefficient of variation for each repeated workload;
- workload failure rate;
- generation-only bandwidth roofline utilization when both on-disk model
  weight size and user-supplied memory bandwidth are available;
- directly detected diagnostics, or an explicit `unavailable` status; and
- the complete measurement configuration and version identifiers.

Roofline utilization applies only to generation. The theoretical ceiling
degrades with context length because KV-cache reads add memory traffic, is not
comparable across different contexts, and is unreachable in practice. It is
meaningful only for the same hardware and model. Prefill has no utilization
percentage.

No temperature or thermal data is measured.

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
- raw timing counters, token counts, client TTFT, validity results, and retry
  history for each pass;
- all derived measurements and diagnostic states.

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

NVIDIA utilization, VRAM, driver version, and compute-process memory use
`nvidia-smi`. When it is unavailable, the collector falls back to Windows CIM
or Linux DRM sysfs for the hardware fields those interfaces expose. Missing
counters and diagnostics remain unavailable rather than being invented.

## Tests and fixtures

```sh
npm test
```

Tests cover every derivation, validity rule, retry rule, diagnostic, CLI
argument rule, JSON privacy boundary, and loopback restriction without a GPU
or Ollama.

The committed fixtures are explicitly synthetic. Real recorded Ollama
responses—including a deliberately misconfigured negative control—must replace
or supplement them during RTX 3080 and RTX 4070 Ti hardware testing before the
protocol freezes or the package reaches `v1.0.0`.

## Draft-protocol limitations

The six open questions in §12 remain open. The current provisional choices are
visible next to their constants and extraction logic. In particular, Ollama
does not currently expose a standard per-layer GPU/CPU assignment in the API
responses this client consumes, so layer-based diagnostics report
`unavailable` instead of inferring layers from byte counts.

The protocol also leaves the W1/W2/W4 context values, warm `keep_alive`, the
non-Ollama GPU-memory threshold, the definition of comfortable context
headroom, population-vs-sample standard deviation, and the failure-rate
denominator unspecified. These choices must be resolved in the protocol before
the first stable release.

## License

MIT
