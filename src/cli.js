#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { OllamaAdapter } from "./adapters/ollama.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { QualityRefusalError, runBenchmark } from "./benchmark.js";
import { matchGpuMemoryBandwidth } from "./derivation/gpu-bandwidth.js";
import { renderReport } from "./output/report.js";
import {
  renderFixtureCaptureSummary,
  writeFixtureCapture,
} from "./output/fixture-writer.js";
import { writeResult } from "./output/writer.js";

function usage() {
  return `Usage: osai-bench [options]

Runs the complete ${PROTOCOL_VERSION} protocol against Ollama on this machine.

Options:
  --model <name>                 Select an installed model non-interactively
  --memory-bandwidth <GB/s>      Override auto-detected GPU memory bandwidth
  --quality-override             Run despite detected quality preconditions
  --output <path>                Result JSON path (must not already exist)
  --capture-fixture <path>       Also save a real-hardware fixture (no overwrite)
  --fixture-label <text>         Required label for --capture-fixture
  --help                         Show this help

Example fixture capture:
  osai-bench --model qwen3:8b --capture-fixture fixtures/rtx-4070-ti.json \\
    --fixture-label "rtx-4070-ti-partial-offload"

The CLI makes no external network calls. Its only HTTP connection is to
Ollama at http://127.0.0.1:11434.`;
}

function parseArguments(argv) {
  const result = {
    model: null,
    memoryBandwidthGBps: null,
    qualityOverride: false,
    outputPath: null,
    captureFixturePath: null,
    fixtureLabel: null,
    help: false,
  };
  const valueOptions = new Map([
    ["--model", "model"],
    ["--memory-bandwidth", "memoryBandwidthGBps"],
    ["--output", "outputPath"],
    ["--capture-fixture", "captureFixturePath"],
    ["--fixture-label", "fixtureLabel"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--quality-override") {
      result.qualityOverride = true;
    } else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      result[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      const matched = [...valueOptions].find(([option]) =>
        argument.startsWith(`${option}=`),
      );
      if (!matched) throw new Error(`Unknown option: ${argument}`);
      result[matched[1]] = argument.slice(matched[0].length + 1);
    }
  }

  if (result.memoryBandwidthGBps !== null) {
    result.memoryBandwidthGBps = Number(result.memoryBandwidthGBps);
    if (
      !Number.isFinite(result.memoryBandwidthGBps) ||
      result.memoryBandwidthGBps <= 0
    ) {
      throw new Error("--memory-bandwidth must be a positive number");
    }
  }
  if (result.captureFixturePath !== null && result.fixtureLabel === null) {
    throw new Error("--capture-fixture requires --fixture-label");
  }
  if (result.fixtureLabel !== null && result.captureFixturePath === null) {
    throw new Error("--fixture-label requires --capture-fixture");
  }
  if (
    result.outputPath !== null &&
    result.captureFixturePath !== null &&
    path.resolve(result.outputPath) === path.resolve(result.captureFixturePath)
  ) {
    throw new Error("--output and --capture-fixture must use different paths");
  }
  return result;
}

async function selectModel(models, readline) {
  output.write("\nInstalled Ollama models:\n");
  models.forEach((model, index) => {
    const identifier = model.name ?? model.model;
    const quantization = model.details?.quantization_level;
    output.write(
      `  ${index + 1}. ${identifier}${quantization ? ` (${quantization})` : ""}\n`,
    );
  });
  const answer = await readline.question("\nSelect a model number: ");
  const selected = Number(answer);
  if (!Number.isInteger(selected) || selected < 1 || selected > models.length) {
    throw new Error("Invalid model selection");
  }
  return models[selected - 1].name ?? models[selected - 1].model;
}

async function askBandwidth(readline) {
  const answer = await readline.question(
    "GPU memory bandwidth in GB/s (Enter to omit roofline utilization): ",
  );
  if (answer.trim() === "") return null;
  const value = Number(answer);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Memory bandwidth must be a positive number");
  }
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    output.write(`${usage()}\n`);
    return 0;
  }

  output.write(
    `OpenSourcesAI Bench — local-only ${PROTOCOL_VERSION}\n` +
      "No telemetry, upload, analytics, version check, or external network access.\n",
  );
  const adapter = new OllamaAdapter();
  let modelsRaw;
  try {
    const detection = await adapter.detect();
    output.write(`Detected Ollama ${detection.raw.version ?? "unknown"}\n`);
    modelsRaw = await adapter.listModels();
  } catch (error) {
    process.stderr.write(
      `Could not connect to local Ollama at http://127.0.0.1:11434.\n${error.message}\n`,
    );
    return 1;
  }

  const models = Array.isArray(modelsRaw.models) ? modelsRaw.models : [];
  if (models.length === 0) {
    process.stderr.write("Ollama is running, but no installed models were found.\n");
    return 1;
  }

  let readline = null;
  try {
    const independent = await adapter.checkModelIndependentPreconditions();
    if (independent.issues.length > 0 && !args.qualityOverride) {
      throw new QualityRefusalError(independent.issues);
    }

    readline =
      input.isTTY && (!args.model || args.memoryBandwidthGBps === null)
        ? createInterface({ input, output })
        : null;
    const model =
      args.model ??
      (input.isTTY
        ? await selectModel(models, readline)
        : (() => {
            throw new Error("--model is required when stdin is not interactive");
          })());
    if (!models.some((entry) => (entry.name ?? entry.model) === model)) {
      throw new Error(`Model ${model} is not installed`);
    }
    let memoryBandwidthGBps = args.memoryBandwidthGBps;
    if (memoryBandwidthGBps === null && input.isTTY) {
      const automaticMatch = matchGpuMemoryBandwidth({
        model: independent.system.gpu.model,
        totalVramBytes: independent.system.gpu.totalVramBytes,
      });
      if (!automaticMatch) {
        memoryBandwidthGBps = await askBandwidth(readline);
      }
    }
    let fixtureCapture = null;
    const record = await runBenchmark({
      adapter,
      model,
      memoryBandwidthGBps,
      qualityOverride: args.qualityOverride,
      modelIndependentPreconditions: independent,
      onProgress: (message) => output.write(`  ${message}\n`),
      onFixtureCapture: args.captureFixturePath
        ? (capture) => {
            fixtureCapture = capture;
          }
        : undefined,
    });
    output.write(`${renderReport(record)}\n`);
    const resultPath = await writeResult(record, args.outputPath);
    output.write(`\nSaved machine-readable result: ${resultPath}\n`);
    if (args.captureFixturePath) {
      const captured = await writeFixtureCapture(fixtureCapture, {
        requestedPath: args.captureFixturePath,
        label: args.fixtureLabel,
        capturedAt: record.createdAt,
      });
      output.write(`${renderFixtureCaptureSummary(captured)}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof QualityRefusalError) {
      process.stderr.write("\nRun refused because:\n");
      for (const issue of error.issues) {
        process.stderr.write(`- ${issue.message}\n`);
      }
      process.stderr.write(
        "\nResolve these conditions and retry. To preserve a knowingly non-standard run, " +
          "rerun with --quality-override; the JSON will be permanently marked and cohort-ineligible.\n",
      );
      return 3;
    }
    process.stderr.write(`${error.message}\n`);
    return 1;
  } finally {
    readline?.close();
  }
}

if (
  process.argv[1] &&
  ["cli.js", "osai-bench", "osai-bench.cmd"].includes(
    path.basename(process.argv[1]),
  )
) {
  process.exitCode = await main();
}

export const __test = { parseArguments, usage };
