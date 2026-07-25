import { promises as fs } from "node:fs";
import path from "node:path";

export function defaultResultFilename(createdAt = new Date().toISOString()) {
  return `osai-bench-result-${createdAt.replace(/[:.]/g, "-")}.json`;
}

export async function writeResult(record, requestedPath = null) {
  const outputPath = path.resolve(
    requestedPath ?? defaultResultFilename(record.createdAt),
  );
  await fs.writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return outputPath;
}
