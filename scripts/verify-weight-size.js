#!/usr/bin/env node
//
// Weight-size verification. Answers §12.6: is Ollama's /api/tags `size` — the
// value the roofline denominator uses as "quantized on-disk weight size"
// (§6.2) — genuinely the model's weight tensor bytes, or does it fold in
// non-weight overhead that would make utilization read systematically low?
//
// Two levels of comparison:
//   1. /api/tags `size` vs the sum of the model's manifest layers. Ollama's
//      `size` is the total of every layer (weights + template + license +
//      params + config), so this exposes exactly how many non-weight bytes
//      ride along.
//   2. The model (weights) layer, which is a GGUF file, parsed directly: its
//      tensor-data region (everything after the header, metadata, and tensor
//      table) is the actual weight bytes. If that region is essentially the
//      whole blob, the blob is genuinely weights.
//
// GGUF is read read-only from Ollama's local blob store; the only network
// call is the optional /api/tags fetch over the loopback endpoint. No deps.
//
//   node scripts/verify-weight-size.js --model llama3.1:8b
//   node scripts/verify-weight-size.js --gguf /path/to/model.gguf

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OllamaAdapter } from "../src/adapters/ollama.js";

function parseArg(argv, flag, fallback = null) {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((v) => v.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return fallback;
}

// ---- GGUF header parser (v2/v3) -----------------------------------------
// Only the header, metadata, and tensor-info table are read; the multi-GB
// tensor-data region is never loaded. Returns the byte offset at which tensor
// data begins, plus the tensor count and the sum of per-tensor sizes derived
// from their declared offsets (a cross-check that tensors tile the region).

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

const VALUE_SIZES = {
  0: 1, // UINT8
  1: 1, // INT8
  2: 2, // UINT16
  3: 2, // INT16
  4: 4, // UINT32
  5: 4, // INT32
  6: 4, // FLOAT32
  7: 1, // BOOL
  10: 8, // UINT64
  11: 8, // INT64
  12: 8, // FLOAT64
};
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;

class Cursor {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }
  u32() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64() {
    const v = Number(this.buf.readBigUInt64LE(this.pos));
    this.pos += 8;
    return v;
  }
  bytes(n) {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  string() {
    const len = this.u64();
    return this.bytes(len).toString("utf8");
  }
  skipValue(type) {
    if (type === TYPE_STRING) {
      this.string();
    } else if (type === TYPE_ARRAY) {
      const elemType = this.u32();
      const count = this.u64();
      for (let i = 0; i < count; i++) this.skipValue(elemType);
    } else if (VALUE_SIZES[type] !== undefined) {
      this.pos += VALUE_SIZES[type];
    } else {
      throw new Error(`Unknown GGUF value type ${type}`);
    }
  }
  readScalarU32(type) {
    // Used only for general.alignment, which is UINT32.
    if (type !== 4) {
      this.skipValue(type);
      return null;
    }
    return this.u32();
  }
}

function parseGguf(filePath) {
  const fileSize = fs.statSync(filePath).size;
  // 64 MiB is far more than any header+metadata+tensor-table for models this
  // tool targets; the tensor-data region beyond it is never needed.
  const headerCap = Math.min(fileSize, 64 * 1024 * 1024);
  const buf = Buffer.alloc(headerCap);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, headerCap, 0);
  } finally {
    fs.closeSync(fd);
  }

  const c = new Cursor(buf);
  const magic = c.u32();
  if (magic !== GGUF_MAGIC) {
    throw new Error(
      `Not a GGUF file (magic 0x${magic.toString(16)} != 0x${GGUF_MAGIC.toString(16)})`,
    );
  }
  const version = c.u32();
  const tensorCount = c.u64();
  const kvCount = c.u64();

  let alignment = 32; // GGUF default when general.alignment is absent.
  for (let i = 0; i < kvCount; i++) {
    const key = c.string();
    const valueType = c.u32();
    if (key === "general.alignment") {
      const a = c.readScalarU32(valueType);
      if (a) alignment = a;
    } else {
      c.skipValue(valueType);
    }
  }

  // Tensor info table: name, n_dims, dims[], ggml_type, offset.
  const offsets = [];
  for (let i = 0; i < tensorCount; i++) {
    c.string(); // name
    const nDims = c.u32();
    for (let d = 0; d < nDims; d++) c.u64(); // dims
    c.u32(); // ggml_type
    offsets.push(c.u64()); // offset within the tensor-data region
  }

  const afterTable = c.pos;
  const dataOffset = Math.ceil(afterTable / alignment) * alignment;
  const tensorDataBytes = fileSize - dataOffset;

  return {
    version,
    tensorCount,
    alignment,
    headerBytes: dataOffset,
    tensorDataBytes,
    fileSize,
    firstTensorOffset: offsets[0] ?? null,
    lastTensorOffset: offsets[offsets.length - 1] ?? null,
  };
}

// ---- Ollama model -> GGUF blob resolution --------------------------------

function ollamaModelsDir() {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  const candidates = [
    path.join(os.homedir(), ".ollama", "models"),
    "/usr/share/ollama/.ollama/models",
    "/var/lib/ollama/.ollama/models",
    "/usr/local/share/ollama/.ollama/models",
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}

function resolveModelBlob(modelsDir, modelName) {
  const [repoAndName, tag = "latest"] = modelName.split(":");
  const repoPath = repoAndName.includes("/")
    ? repoAndName
    : `library/${repoAndName}`;
  const manifestPath = path.join(
    modelsDir,
    "manifests",
    "registry.ollama.ai",
    ...repoPath.split("/"),
    tag,
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const layerSum = manifest.layers.reduce((a, l) => a + l.size, 0);
  const modelLayer = manifest.layers.find((l) =>
    l.mediaType.endsWith(".model"),
  );
  if (!modelLayer) throw new Error("No .model layer in manifest");
  const digest = modelLayer.digest.replace("sha256:", "sha256-");
  return {
    blobPath: path.join(modelsDir, "blobs", digest),
    modelLayerSize: modelLayer.size,
    manifestLayerSum: layerSum,
    layers: manifest.layers.map((l) => ({
      kind: l.mediaType.split(".").pop(),
      size: l.size,
    })),
  };
}

function fmtGB(bytes) {
  return `${(bytes / 1e9).toFixed(4)} GB`;
}

// ---- main ----------------------------------------------------------------

const argv = process.argv.slice(2);
const model = parseArg(argv, "--model");
const ggufPath = parseArg(argv, "--gguf");

if (!model && !ggufPath) {
  process.stderr.write(
    "Usage: node scripts/verify-weight-size.js (--model <name> | --gguf <path>)\n",
  );
  process.exit(2);
}

if (ggufPath) {
  const g = parseGguf(ggufPath);
  console.log(`GGUF: ${ggufPath}`);
  console.log(`- version ${g.version}, ${g.tensorCount} tensors, alignment ${g.alignment}`);
  console.log(`- header + metadata + tensor table: ${g.headerBytes} bytes`);
  console.log(`- tensor data (weights): ${g.tensorDataBytes} (${fmtGB(g.tensorDataBytes)})`);
  console.log(`- file size: ${g.fileSize} (${fmtGB(g.fileSize)})`);
  const pct = (g.tensorDataBytes / g.fileSize) * 100;
  console.log(`- weights are ${pct.toFixed(4)}% of the file`);
  process.exit(0);
}

const modelsDir = ollamaModelsDir();
if (!modelsDir) {
  process.stderr.write("Could not locate the Ollama models directory (set OLLAMA_MODELS).\n");
  process.exit(1);
}
const resolved = resolveModelBlob(modelsDir, model);
const g = parseGguf(resolved.blobPath);

// /api/tags size over the loopback endpoint (same source the tool uses).
const adapter = new OllamaAdapter();
const tags = await adapter.listModels();
const entry = tags.models.find((m) => m.name === model || m.model === model);
const tagsSize = entry ? entry.size : null;

console.log(`Model: ${model}`);
console.log(`Models dir: ${modelsDir}`);
console.log("");
console.log("Level 1 — /api/tags size vs manifest layers");
if (tagsSize !== null) {
  console.log(`- /api/tags size:      ${tagsSize} (${fmtGB(tagsSize)})`);
}
console.log(`- manifest layer sum:  ${resolved.manifestLayerSum} (${fmtGB(resolved.manifestLayerSum)})`);
console.log(`- model (weights) layer: ${resolved.modelLayerSize} (${fmtGB(resolved.modelLayerSize)})`);
for (const l of resolved.layers) {
  if (l.kind !== "model") console.log(`  - non-weight layer (${l.kind}): ${l.size} bytes`);
}
const nonWeight = resolved.manifestLayerSum - resolved.modelLayerSize;
console.log(`- non-weight overhead in size: ${nonWeight} bytes (${((nonWeight / resolved.manifestLayerSum) * 100).toFixed(5)}%)`);
console.log("");
console.log("Level 2 — model blob parsed as GGUF");
console.log(`- version ${g.version}, ${g.tensorCount} tensors, alignment ${g.alignment}`);
console.log(`- header + metadata + tensor table: ${g.headerBytes} bytes`);
console.log(`- tensor data (weights): ${g.tensorDataBytes} (${fmtGB(g.tensorDataBytes)})`);
console.log(`- blob file size: ${g.fileSize} (${fmtGB(g.fileSize)})`);
console.log(`- tensor data is ${((g.tensorDataBytes / g.fileSize) * 100).toFixed(4)}% of the blob`);
console.log("");
if (tagsSize !== null) {
  const ratio = (g.tensorDataBytes / tagsSize) * 100;
  console.log(
    `Conclusion: genuine weight tensor bytes are ${ratio.toFixed(3)}% of the /api/tags ` +
      `size used as the roofline denominator.`,
  );
}
