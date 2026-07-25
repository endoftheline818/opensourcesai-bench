import { promises as fs } from "node:fs";
import path from "node:path";

export function defaultResultFilename(createdAt = new Date().toISOString()) {
  return `osai-bench-result-${createdAt.replace(/[:.]/g, "-")}.json`;
}

export async function writeResult(record, requestedPath = null) {
  const outputPath = path.resolve(
    requestedPath ?? defaultResultFilename(record.createdAt),
  );
  // Create the parent directory first. Without this, a completed run — five
  // minutes of measurement that cannot be reproduced without re-running — is
  // discarded with ENOENT because the target folder does not exist yet. The
  // wx flag below still guarantees an existing file is never overwritten.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return outputPath;
}
