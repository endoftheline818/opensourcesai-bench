/*
 * REQUIRES HUMAN VERIFICATION BEFORE RELEASE.
 *
 * Every entry must cite a manufacturer specification. Do not add values from
 * memory, secondary databases, retailer listings, or calculated bus width and
 * data rate. An absent entry intentionally makes roofline utilization
 * unavailable while preserving throughput reporting.
 */
export const GPU_MEMORY_BANDWIDTH_TABLE = Object.freeze({
  schemaVersion: "osai-gpu-memory-bandwidth/1",
  releaseStatus: "requires-human-verification",
  units: "GB/s",
  entries: Object.freeze([
    Object.freeze({
      id: "nvidia-geforce-rtx-3080-10gb",
      match: Object.freeze({
        detectionNames: Object.freeze(["NVIDIA GeForce RTX 3080"]),
        nominalVramMiB: 10240,
        vramToleranceMiB: 256,
      }),
      memoryBandwidthGBps: 760,
      source: Object.freeze({
        manufacturer: "NVIDIA",
        title: "NVIDIA Ampere GA102 GPU Architecture",
        url: "https://www.nvidia.com/content/PDF/nvidia-ampere-ga-102-gpu-architecture-whitepaper-v2.1.pdf",
        locator: "Table 2, GeForce RTX 3080 10 GB, Memory Bandwidth",
      }),
    }),
    Object.freeze({
      id: "nvidia-geforce-rtx-4070-ti-12gb",
      match: Object.freeze({
        detectionNames: Object.freeze(["NVIDIA GeForce RTX 4070 Ti"]),
        nominalVramMiB: 12288,
        vramToleranceMiB: 256,
      }),
      memoryBandwidthGBps: 504,
      source: Object.freeze({
        manufacturer: "NVIDIA",
        title: "NVIDIA RTX Blackwell GPU Architecture",
        url: "https://images.nvidia.com/aem-dam/Solutions/geforce/blackwell/nvidia-rtx-blackwell-gpu-architecture.pdf",
        locator: "Table 5, RTX 4070 Ti, Memory Bandwidth",
      }),
    }),
  ]),
});
