import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import {
  FIXED_OPTIONS,
  NON_OLLAMA_GPU_MEMORY_THRESHOLD_MIB,
  PROTOCOL_VERSION,
} from "../protocol.js";

const execFileAsync = promisify(execFile);
const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const REQUEST_TIMEOUT_MS = 30_000;

function assertLoopbackUrl(value) {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("Ollama requests are restricted to a local HTTP loopback endpoint");
  }
  return url;
}

function requestOptions(endpoint, method) {
  const url = assertLoopbackUrl(new URL(endpoint, OLLAMA_ORIGIN).toString());
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: { "content-type": "application/json" },
  };
}

function ollamaConnectionError(endpoint, error) {
  const url = new URL(endpoint, OLLAMA_ORIGIN).toString();
  return new Error(
    `Could not reach local Ollama at ${url}: ${error.message}. ` +
      "Start Ollama and retry.",
    { cause: error },
  );
}

async function requestJson(endpoint, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(requestOptions(endpoint, method), (response) => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(
            new Error(
              `Ollama ${endpoint} returned HTTP ${response.statusCode}: ${text.trim()}`,
            ),
          );
          return;
        }
        try {
          resolve(text.length === 0 ? {} : JSON.parse(text));
        } catch (error) {
          reject(new Error(`Ollama ${endpoint} returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Ollama ${endpoint} timed out`));
    });
    request.on("error", (error) => {
      reject(ollamaConnectionError(endpoint, error));
    });
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

// A streamed chunk carries a generated token when it has non-empty text in
// EITHER channel. Ollama routes a reasoning model's chain-of-thought to a
// separate `thinking` field, leaving `response` empty until the model exits
// its reasoning phase. A thinking token is still a streamed generated token,
// and §5.2 defines TTFT as time to the first *streamed token*, not the first
// visible one. Keying only on `response` reported TTFT as unavailable for a
// thinking model that never emits a visible token within num_predict —
// observed on qwen3:8b (W2, num_predict 128: 128 tokens generated, every one
// in the thinking channel, response empty throughout). See the 0.7.0 changelog.
function streamedChunkHasToken(chunk) {
  return (
    (typeof chunk.response === "string" && chunk.response.length > 0) ||
    (typeof chunk.thinking === "string" && chunk.thinking.length > 0)
  );
}

// Narrower than streamedChunkHasToken: true only for a token a caller would
// actually SEE, ignoring the `thinking` channel entirely. §5.2's canonical
// TTFT deliberately counts thinking tokens (above), but that leaves no way to
// answer "how long did the user actually wait before anything appeared" for a
// reasoning model — a real, separate question, and for a deep-reasoning model
// it can diverge by two orders of magnitude from streamed TTFT. Observed on
// gemma4:31b (lab run 9, 2026-08-03): when the workload's num_predict budget
// is exhausted entirely inside reasoning, Ollama emits ZERO chunks with
// content in either channel — a direct probe on real hardware confirmed a
// 16-token generate call returned exactly one terminal chunk, response
// empty, no `thinking` field present at all. streamedChunkHasToken correctly
// reports no token there (there genuinely was none to stream), and this
// tracks the same true absence — it exists to give the LONGER-budget
// workload a chance to observe a token this one may never see.
function streamedChunkHasVisibleToken(chunk) {
  return typeof chunk.response === "string" && chunk.response.length > 0;
}

async function requestNdjson(endpoint, body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let buffer = "";
    let firstTokenAt = null;
    let firstVisibleTokenAt = null;
    let dispatchAt = null;
    const request = http.request(requestOptions(endpoint, "POST"), (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.setEncoding("utf8");
        let errorText = "";
        response.on("data", (chunk) => {
          errorText += chunk;
        });
        response.on("end", () => {
          reject(
            new Error(
              `Ollama ${endpoint} returned HTTP ${response.statusCode}: ${errorText.trim()}`,
            ),
          );
        });
        return;
      }

      response.setEncoding("utf8");
      response.on("data", (data) => {
        buffer += data;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = JSON.parse(line);
            chunks.push(parsed);
            const now =
              firstTokenAt === null || firstVisibleTokenAt === null
                ? performance.now()
                : null;
            if (firstTokenAt === null && streamedChunkHasToken(parsed)) {
              firstTokenAt = now;
            }
            if (
              firstVisibleTokenAt === null &&
              streamedChunkHasVisibleToken(parsed)
            ) {
              firstVisibleTokenAt = now;
            }
          } catch (error) {
            reject(new Error(`Ollama stream returned invalid NDJSON: ${error.message}`));
            request.destroy();
            return;
          }
        }
      });
      response.on("end", () => {
        if (buffer.trim().length > 0) {
          try {
            const parsed = JSON.parse(buffer);
            chunks.push(parsed);
            const now =
              firstTokenAt === null || firstVisibleTokenAt === null
                ? performance.now()
                : null;
            if (firstTokenAt === null && streamedChunkHasToken(parsed)) {
              firstTokenAt = now;
            }
            if (
              firstVisibleTokenAt === null &&
              streamedChunkHasVisibleToken(parsed)
            ) {
              firstVisibleTokenAt = now;
            }
          } catch (error) {
            reject(new Error(`Ollama stream returned invalid NDJSON: ${error.message}`));
            return;
          }
        }
        resolve({
          // Raw runtime response objects are returned without modification.
          chunks,
          timeToFirstTokenMs:
            firstTokenAt === null ? null : firstTokenAt - dispatchAt,
          timeToFirstVisibleTokenMs:
            firstVisibleTokenAt === null
              ? null
              : firstVisibleTokenAt - dispatchAt,
        });
      });
    });
    request.setTimeout(0);
    request.on("error", (error) => {
      reject(ollamaConnectionError(endpoint, error));
    });
    request.write(JSON.stringify(body));
    dispatchAt = performance.now();
    request.end();
  });
}

async function execSafe(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.trim?.() ?? "",
      stderr: error.stderr?.trim?.() ?? error.message,
    };
  }
}

function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

// nvidia-smi's utilization.gpu is "percent of the last sample period during
// which a kernel was executing" — a rolling, bursty figure, not a stable
// state. Ordinary desktop apps (browser tabs, Electron/CEF apps, the NVIDIA
// overlay itself) redraw periodically and can register a brief spike well
// above the §4 contention threshold even when nothing is actually competing
// for the GPU. Observed directly: one nvidia-smi call read 25% and refused a
// run; a manual nvidia-smi call moments later, with nothing closed, read 0%.
// A short burst of samples plus the median means a single transient blip
// cannot trigger a refusal on an otherwise idle machine, while sustained
// contention — a real competing workload — still shows up across all of them.
const GPU_UTILIZATION_SAMPLES = 3;
const GPU_UTILIZATION_SAMPLE_INTERVAL_MS = 200;

async function sampleGpuUtilization() {
  const result = await execSafe("nvidia-smi", [
    "--query-gpu=utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (!result.ok || !result.stdout) return null;
  return result.stdout.split(/\r?\n/).map((line) => Number(line.trim()));
}

async function queryNvidia() {
  const gpuQuery = await execSafe("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.free,utilization.gpu,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  if (!gpuQuery.ok || !gpuQuery.stdout) {
    return { available: false, gpus: [], processes: [] };
  }

  const gpus = gpuQuery.stdout.split(/\r?\n/).map((line) => {
    const [model, totalMiB, freeMiB, utilizationPercent, driverVersion] =
      parseCsvLine(line);
    return {
      model,
      totalVramBytes: Number(totalMiB) * 1024 ** 2,
      freeVramBytes: Number(freeMiB) * 1024 ** 2,
      utilizationPercent: Number(utilizationPercent),
      driverVersion,
    };
  });

  const utilizationSamples = [gpus.map((gpu) => gpu.utilizationPercent)];
  for (let sample = 1; sample < GPU_UTILIZATION_SAMPLES; sample += 1) {
    await sleep(GPU_UTILIZATION_SAMPLE_INTERVAL_MS);
    const reading = await sampleGpuUtilization();
    if (reading) utilizationSamples.push(reading);
  }
  gpus.forEach((gpu, index) => {
    const values = utilizationSamples
      .map((sample) => sample[index])
      .filter((value) => Number.isFinite(value));
    if (values.length > 0) gpu.utilizationPercent = median(values);
  });

  const processQuery = await execSafe("nvidia-smi", [
    "--query-compute-apps=process_name,used_gpu_memory",
    "--format=csv,noheader,nounits",
  ]);
  const processes =
    processQuery.ok && processQuery.stdout
      ? processQuery.stdout.split(/\r?\n/).map((line) => {
          const [processName, usedMiB] = parseCsvLine(line);
          return { processName, usedMemoryMiB: Number(usedMiB) };
        })
      : [];

  return { available: true, gpus, processes };
}

async function queryWindowsDisplayAdapters() {
  const result = await execSafe("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress",
  ]);
  if (!result.ok || !result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(
        (entry) =>
          entry?.Name &&
          !/Microsoft Basic|Remote Display|Virtual Display/i.test(entry.Name),
      )
      .map((entry) => ({
        model: entry.Name,
        totalVramBytes:
          Number.isFinite(entry.AdapterRAM) && entry.AdapterRAM > 0
            ? entry.AdapterRAM
            : null,
        freeVramBytes: null,
        utilizationPercent: null,
        driverVersion: entry.DriverVersion ?? null,
        provider: "windows-cim",
      }));
  } catch {
    return [];
  }
}

async function readNumber(filePath) {
  try {
    const value = Number((await fs.readFile(filePath, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function queryLinuxDisplayAdapters() {
  try {
    const entries = await fs.readdir("/sys/class/drm", { withFileTypes: true });
    const cards = entries.filter(
      (entry) => entry.isDirectory() && /^card\d+$/.test(entry.name),
    );
    const adapters = [];
    for (const card of cards) {
      const deviceDirectory = path.join("/sys/class/drm", card.name, "device");
      const [vendor, device, uevent, totalVram, usedVram, utilization] =
        await Promise.all([
          fs.readFile(path.join(deviceDirectory, "vendor"), "utf8").catch(() => ""),
          fs.readFile(path.join(deviceDirectory, "device"), "utf8").catch(() => ""),
          fs.readFile(path.join(deviceDirectory, "uevent"), "utf8").catch(() => ""),
          readNumber(path.join(deviceDirectory, "mem_info_vram_total")),
          readNumber(path.join(deviceDirectory, "mem_info_vram_used")),
          readNumber(path.join(deviceDirectory, "gpu_busy_percent")),
        ]);
      if (!vendor.trim()) continue;
      const driver = uevent.match(/^DRIVER=(.+)$/m)?.[1] ?? null;
      const pciId = `${vendor.trim()}:${device.trim()}`;
      adapters.push({
        model: `${driver ?? "DRM GPU"} (${pciId})`,
        totalVramBytes: totalVram,
        freeVramBytes:
          Number.isFinite(totalVram) && Number.isFinite(usedVram)
            ? Math.max(0, totalVram - usedVram)
            : null,
        utilizationPercent: utilization,
        driverVersion: null,
        provider: "linux-drm-sysfs",
      });
    }
    return adapters;
  } catch {
    return [];
  }
}

async function queryDisplayAdapters() {
  return process.platform === "win32"
    ? queryWindowsDisplayAdapters()
    : queryLinuxDisplayAdapters();
}

async function queryWindowsBattery() {
  const result = await execSafe("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus | ConvertTo-Json -Compress",
  ]);
  if (!result.ok || !result.stdout) return { present: false, onBattery: false };
  try {
    const status = JSON.parse(result.stdout).BatteryStatus;
    return { present: true, onBattery: status === 1 };
  } catch {
    return { present: null, onBattery: null };
  }
}

async function queryLinuxBattery() {
  try {
    const entries = await fs.readdir("/sys/class/power_supply", {
      withFileTypes: true,
    });
    const batteries = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("BAT")) continue;
      const status = await fs
        .readFile(path.join("/sys/class/power_supply", entry.name, "status"), "utf8")
        .catch(() => null);
      batteries.push(status?.trim() ?? null);
    }
    return {
      present: batteries.length > 0,
      onBattery: batteries.some((status) => status === "Discharging"),
    };
  } catch {
    return { present: null, onBattery: null };
  }
}

async function queryLinuxCpuModel() {
  try {
    const cpuInfo = await fs.readFile("/proc/cpuinfo", "utf8");
    return (
      cpuInfo.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ??
      os.cpus()[0]?.model ??
      null
    );
  } catch {
    return os.cpus()[0]?.model ?? null;
  }
}

async function queryOsVersion() {
  if (process.platform !== "linux") return os.release();
  try {
    const release = await fs.readFile("/etc/os-release", "utf8");
    const pretty = release.match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/m);
    return pretty?.[1] ?? pretty?.[2] ?? os.release();
  } catch {
    return os.release();
  }
}

function isOllamaProcess(processName) {
  if (/(^|[\\/])ollama(?:\.exe)?$/i.test(processName)) return true;
  // Ollama's actual GPU compute runs in a separately named runner process, not
  // the `ollama` binary itself — observed directly on the RTX 3080 hardware
  // session: /usr/local/lib/ollama/llama-server, resident and warm from an
  // earlier call (keep_alive keeps it loaded), reported by nvidia-smi as
  // "non-Ollama compute" and refusing every subsequent run deterministically,
  // not as a one-off. Recognized only when "llama-server" sits inside an
  // "ollama" path segment, so an unrelated standalone llama.cpp server a user
  // runs themselves — same binary name, no "ollama" in its path — is still
  // correctly counted as real contention.
  //
  // Windows equivalent unconfirmed: this session's Windows runs never hit the
  // refusal, so either its runner is reported differently by nvidia-smi or
  // this basename doesn't apply there. Add a Windows-specific pattern only
  // once a real path is observed -- do not guess one.
  return /[\\/]ollama[\\/].*llama-server(?:\.exe)?$/i.test(processName);
}

function modelIndependentIssues(system) {
  const issues = [];
  if (system.power.onBattery === true) {
    issues.push({
      code: "on-battery",
      message: "System is running on battery power",
    });
  }
  if (
    Number.isFinite(system.gpu.utilizationPercent) &&
    system.gpu.utilizationPercent > 10
  ) {
    issues.push({
      code: "gpu-utilization",
      message: `Pre-existing GPU utilization is ${system.gpu.utilizationPercent}% (>10%)`,
    });
  }

  const nonOllama = system.gpuProcesses.filter(
    (processEntry) => !isOllamaProcess(processEntry.processName),
  );
  const nonOllamaMiB = nonOllama.reduce(
    (sum, processEntry) => sum + (processEntry.usedMemoryMiB || 0),
    0,
  );
  if (nonOllamaMiB > NON_OLLAMA_GPU_MEMORY_THRESHOLD_MIB) {
    issues.push({
      code: "non-ollama-gpu-memory",
      message:
        `Non-Ollama compute processes use ${nonOllamaMiB} MiB GPU memory ` +
        `(>${NON_OLLAMA_GPU_MEMORY_THRESHOLD_MIB} MiB provisional threshold)`,
    });
  }

  if (system.gpuCount > 1) {
    issues.push({
      code: "multiple-gpus-unsupported",
      message: `${system.gpuCount} GPUs detected; ${PROTOCOL_VERSION} supports one discrete GPU`,
    });
  }
  return issues;
}

function modelDependentIssues(runningRaw, targetModel) {
  const issues = [];
  const loaded = Array.isArray(runningRaw.models) ? runningRaw.models : [];
  for (const model of loaded) {
    const identifier = model.name ?? model.model;
    if (identifier && identifier !== targetModel) {
      issues.push({
        code: "different-model-loaded",
        message: `Ollama already has non-target model ${identifier} loaded`,
      });
    }
  }
  return issues;
}

export class OllamaAdapter {
  constructor() {
    this.name = "ollama";
    this.endpoint = OLLAMA_ORIGIN;
  }

  async detect() {
    const version = await requestJson("/api/version");
    return { available: true, raw: version };
  }

  async listModels() {
    // Return the runtime response unchanged.
    return requestJson("/api/tags");
  }

  async showModel(model) {
    return requestJson("/api/show", { method: "POST", body: { model } });
  }

  async listRunningModels() {
    return requestJson("/api/ps");
  }

  // I/O only: hand the raw process environment to the derivation layer, which
  // owns the allowlist. This is the CLIENT's environment, not the Ollama
  // server's -- see src/derivation/environment.js for why that distinction
  // matters and why nothing derived from it may feed a measurement.
  readEnvironment() {
    return { ...process.env };
  }

  async generate(model, workload) {
    return requestNdjson("/api/generate", {
      model,
      prompt: workload.prompt,
      stream: true,
      keep_alive: workload.keepAlive,
      options: {
        ...FIXED_OPTIONS,
        num_predict: workload.numPredict,
        num_ctx: workload.numCtx,
      },
    });
  }

  async forceUnload(model) {
    return requestNdjson("/api/generate", {
      model,
      prompt: "Unload.",
      stream: true,
      keep_alive: 0,
      options: {
        ...FIXED_OPTIONS,
        num_predict: 1,
        num_ctx: 512,
      },
    });
  }

  async collectSystemSnapshot() {
    const [nvidia, battery, cpuModel, osVersion] = await Promise.all([
      queryNvidia(),
      process.platform === "win32"
        ? queryWindowsBattery()
        : queryLinuxBattery(),
      process.platform === "linux"
        ? queryLinuxCpuModel()
        : Promise.resolve(os.cpus()[0]?.model ?? null),
      queryOsVersion(),
    ]);
    const fallbackGpus = nvidia.available ? [] : await queryDisplayAdapters();
    const detectedGpus = nvidia.available ? nvidia.gpus : fallbackGpus;
    const gpu = detectedGpus[0] ?? null;
    return {
      cpu: { model: cpuModel },
      gpu: gpu
        ? {
            present: true,
            model: gpu.model,
            totalVramBytes: gpu.totalVramBytes,
            freeVramBytes: gpu.freeVramBytes,
            utilizationPercent: gpu.utilizationPercent,
            driverVersion: gpu.driverVersion,
            provider: gpu.provider ?? "nvidia-smi",
          }
        : {
            present: false,
            model: null,
            totalVramBytes: null,
            freeVramBytes: null,
            utilizationPercent: null,
            driverVersion: null,
            provider: null,
          },
      gpuCount: detectedGpus.length,
      gpuProcesses: nvidia.processes,
      memory: { totalBytes: os.totalmem() },
      os: {
        platform: process.platform,
        version: osVersion,
        architecture: process.arch,
      },
      power: battery,
    };
  }

  async checkModelIndependentPreconditions() {
    const system = await this.collectSystemSnapshot();
    return { issues: modelIndependentIssues(system), system };
  }

  async checkModelDependentPreconditions(targetModel) {
    const rawRunningModels = await this.listRunningModels();
    return {
      issues: modelDependentIssues(rawRunningModels, targetModel),
      rawRunningModels,
    };
  }

  async checkPreconditions(targetModel) {
    const [independent, dependent] = await Promise.all([
      this.checkModelIndependentPreconditions(),
      this.checkModelDependentPreconditions(targetModel),
    ]);
    return {
      issues: [...independent.issues, ...dependent.issues],
      system: independent.system,
      rawRunningModels: dependent.rawRunningModels,
    };
  }
}

export const __test = {
  assertLoopbackUrl,
  isOllamaProcess,
  modelDependentIssues,
  modelIndependentIssues,
  ollamaConnectionError,
  parseCsvLine,
  streamedChunkHasToken,
  streamedChunkHasVisibleToken,
};
