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
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

async function requestNdjson(endpoint, body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let buffer = "";
    let firstTokenAt = null;
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
            if (
              firstTokenAt === null &&
              typeof parsed.response === "string" &&
              parsed.response.length > 0
            ) {
              firstTokenAt = performance.now();
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
            if (
              firstTokenAt === null &&
              typeof parsed.response === "string" &&
              parsed.response.length > 0
            ) {
              firstTokenAt = performance.now();
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
        });
      });
    });
    request.setTimeout(0);
    request.on("error", reject);
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
  return /(^|[\\/])ollama(?:\.exe)?$/i.test(processName);
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

  async checkPreconditions(targetModel) {
    const [system, runningRaw] = await Promise.all([
      this.collectSystemSnapshot(),
      this.listRunningModels(),
    ]);
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
        message: `${system.gpuCount} GPUs detected; osai-bench/1.1 supports one discrete GPU`,
      });
    }

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

    return { issues, system, rawRunningModels: runningRaw };
  }
}

export const __test = { assertLoopbackUrl, isOllamaProcess, parseCsvLine };
