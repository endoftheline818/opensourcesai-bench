import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultResultFilename(createdAt = new Date().toISOString()) {
  return `osai-bench-result-${createdAt.replace(/[:.]/g, "-")}.json`;
}

/**
 * Where results land when no --output is given: `~/.osai/bench-results/`.
 *
 * A KNOWN location rather than the working directory, so a result outlives the
 * terminal session that produced it and other local tools can offer to open it
 * without being told where it went — a five-minute measurement that lands in
 * whatever directory the shell happened to be in is a result waiting to be
 * lost. Home-based (not a platform data dir) on purpose: results are
 * user-facing documents someone will attach to an issue or drop into a viewer,
 * not application state, and the same path spelling works on every platform.
 * An explicit --output always wins, unchanged.
 */
export function defaultResultsDirectory({ home = os.homedir() } = {}) {
  return path.join(home, ".osai", "bench-results");
}

export async function writeResult(
  record,
  requestedPath = null,
  { resultsDirectory = null } = {},
) {
  const outputPath = path.resolve(
    requestedPath ??
      path.join(
        resultsDirectory ?? defaultResultsDirectory(),
        defaultResultFilename(record.createdAt),
      ),
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
