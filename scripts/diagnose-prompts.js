#!/usr/bin/env node
//
// Prompt sizing diagnostic. Answers §12.1 and §12.5 with measured token counts
// instead of estimates, in seconds rather than a full protocol run.
//
// Sends each workload's real call-time prompt (via buildCallPrompt, the same
// construction the benchmark itself uses — see §5.2.1 for w3's cache-bust
// marker) to the local Ollama endpoint with num_predict = 1, then reports the
// resolved prompt_eval_count against that workload's accepted band and its
// num_ctx. Same loopback-only constraint as the benchmark: no other network
// access. Note: this issues one call per workload, so it cannot by itself
// reveal the prefix-cache reuse that only appears when a prompt repeats
// across a warm model — that is what the negative control and repeated real
// runs are for.
//
//   node scripts/diagnose-prompts.js --model llama3.1:8b

import { OllamaAdapter } from "../src/adapters/ollama.js";
import { buildCallPrompt, WORKLOADS } from "../src/protocol.js";
import { extractRawMeasurement } from "../src/derivation/ollama.js";

function parseModel(argv) {
  const index = argv.indexOf("--model");
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((value) => value.startsWith("--model="));
  if (inline) return inline.slice("--model=".length);
  return null;
}

const model = parseModel(process.argv.slice(2));
if (!model) {
  process.stderr.write("Usage: node scripts/diagnose-prompts.js --model <name>\n");
  process.exit(2);
}

const adapter = new OllamaAdapter();

console.log(`Measuring prompt token counts for ${model}\n`);
console.log(
  "workload  chars   prompt_eval_count  band              num_ctx  verdict",
);
console.log("-".repeat(78));

let anyProblem = false;

for (const workload of Object.values(WORKLOADS)) {
  // Probed with the SAME prompt the benchmark's warmup call would actually
  // send (callIndex 0) — not the bare workload.prompt — so this reports the
  // real prompt_eval_count including the cache-bust marker's overhead (§5.2.1)
  // for workloads where that applies. Without this, the diagnostic and the
  // benchmark could silently disagree on what "the prompt" measures.
  const actualPrompt = buildCallPrompt(workload, 0);
  // num_predict = 1 keeps this fast; only the prompt side is under test.
  const probe = { ...workload, model, prompt: actualPrompt, numPredict: 1 };
  let count = null;
  let error = null;
  try {
    const raw = await adapter.generate(model, probe);
    count = extractRawMeasurement(raw)?.prompt_eval_count ?? null;
  } catch (caught) {
    error = caught.message;
  }

  const band = workload.promptTokenRange;
  const bandText = band ? `${band.min}-${band.max}` : "none";
  let verdict;
  if (error) {
    verdict = `ERROR: ${error}`;
    anyProblem = true;
  } else if (count === null) {
    verdict = "no prompt_eval_count returned";
    anyProblem = true;
  } else if (count >= workload.numCtx) {
    verdict = "TRUNCATED — count reached num_ctx";
    anyProblem = true;
  } else if (band && (count < band.min || count > band.max)) {
    verdict = count < band.min ? "BELOW band" : "ABOVE band";
    anyProblem = true;
  } else {
    verdict = "ok";
  }

  console.log(
    `${workload.id.padEnd(9)} ${String(actualPrompt.length).padEnd(7)} ` +
      `${String(count ?? "-").padEnd(18)} ${bandText.padEnd(17)} ` +
      `${String(workload.numCtx).padEnd(8)} ${verdict}`,
  );
}

console.log(
  anyProblem
    ? "\nAt least one prompt does not satisfy its own rules. The counts above are " +
        "measured, so use them to set the bands rather than re-estimating."
    : "\nAll prompts satisfy their bands and fit inside their context windows.",
);
