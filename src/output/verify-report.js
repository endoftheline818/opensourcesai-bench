function line(label, value) {
  return `- ${label.padEnd(22)} ${value ?? "unavailable"}`;
}

function differenceLines(differences, limit = 20) {
  const shown = differences.slice(0, limit).map(
    (entry) =>
      `  ${entry.path}: recorded ${JSON.stringify(entry.recorded)}, ` +
      `recomputed ${JSON.stringify(entry.recomputed)}`,
  );
  if (differences.length > limit) {
    shown.push(`  ...and ${differences.length - limit} more`);
  }
  return shown;
}

export function renderVerifyReport(report, { path }) {
  const lines = [
    "",
    `Verifying stored result: ${path}`,
    "",
    "Identity:",
    line("protocolVersion", report.identity.protocolVersion),
    line("scoringVersion", report.identity.scoringVersion),
    line("clientVersion", report.identity.clientVersion),
    line("runtime version", report.identity.runtime),
    line("model", report.identity.model),
    line("model digest", report.identity.modelDigest),
    line("createdAt", report.identity.createdAt),
    line(
      "cohort eligibility",
      report.identity.cohortEligible === null
        ? null
        : `${report.identity.cohortEligible}` +
          (report.identity.qualityOverride ? " (quality override)" : ""),
    ),
  ];

  if (report.unverifiable) {
    lines.push("", `UNVERIFIABLE — ${report.unverifiable}`, "");
    return lines.join("\n");
  }

  lines.push("", "Checks:");

  lines.push(
    report.missingIdentity.length === 0
      ? "- identity fields: complete"
      : `- identity fields: MISSING ${report.missingIdentity.join(", ")}`,
  );

  if (!report.configuration.checkable) {
    lines.push(
      "- configuration: not checkable — the record states a different protocol " +
        "version than this client implements, so its configuration answers to a " +
        "contract this build does not carry",
    );
  } else if (report.configuration.drift.length === 0) {
    lines.push(
      "- configuration: matches the workload definitions its protocol version specifies",
    );
  } else {
    lines.push("- configuration: DRIFT");
    lines.push(...differenceLines(report.configuration.drift));
  }

  if (report.passIntegrity.length === 0) {
    lines.push(
      "- pass records: each pass's stored measurement and verdict match its final attempt",
    );
  } else {
    lines.push(
      `- pass records: ${report.passIntegrity.length} pass-level value(s) DISAGREE ` +
        "with the final attempt they are copied from",
    );
    lines.push(...differenceLines(report.passIntegrity));
  }

  lines.push(
    report.validity.mismatches.length === 0
      ? `- validity: ${report.validity.checked} of ${report.counts.attempts} stored attempts ` +
        "rechecked, every verdict reproduced"
      : `- validity: ${report.validity.mismatches.length} of ${report.validity.checked} ` +
        "rechecked verdicts DISAGREE with the stored record",
  );
  for (const mismatch of report.validity.mismatches.slice(0, 20)) {
    lines.push(
      `  ${mismatch.workload} pass ${mismatch.pass} attempt ${mismatch.attempt}: ` +
        `recorded valid=${mismatch.recorded}, recomputed valid=${mismatch.recomputed}` +
        (mismatch.reasons.length > 0 ? ` (${mismatch.reasons.join(", ")})` : ""),
    );
  }

  if (!report.derived.comparable) {
    lines.push(
      "- derived figures: not recomputed — the record was scored under different " +
        "rules than this client applies. A scoring change recomputes history by " +
        "design, so a difference here would be the system working, not a fault",
    );
  } else if (report.derived.mismatches.length === 0) {
    lines.push(
      "- derived figures: every figure reproduced exactly from the stored raw measurements",
    );
  } else {
    lines.push(
      `- derived figures: ${report.derived.mismatches.length} DISAGREE with what ` +
        "the stored raw measurements imply",
    );
    lines.push(...differenceLines(report.derived.mismatches));
  }

  lines.push(
    "",
    report.consistent
      ? "CONSISTENT — the stored figures follow from the stored measurements under the stated rules."
      : "INCONSISTENT — see the disagreements above.",
    "",
    "This establishes internal consistency, not authenticity. A record whose",
    "measurements were invented and then made self-consistent passes every check",
    "here, because every check here is computable by whoever invented them. No",
    "client-side check can establish that a measurement really happened.",
  );

  return lines.join("\n");
}
