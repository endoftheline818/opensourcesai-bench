import { MAX_RETRIES, WORKLOADS } from "./protocol.js";

export const FIXTURE_SCHEMA_VERSION = "osai-bench-fixture/2";

function fixtureError(message) {
  return new Error(`Invalid fixture (${FIXTURE_SCHEMA_VERSION}): ${message}`);
}

export function validateFixtureFormat(fixture) {
  if (fixture?.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    const received =
      typeof fixture?.schemaVersion === "string"
        ? fixture.schemaVersion
        : "(missing)";
    throw new Error(
      `Unsupported fixture schemaVersion ${received}; expected ${FIXTURE_SCHEMA_VERSION}. ` +
        "Old single-response fixtures must be migrated or recaptured.",
    );
  }

  if (!fixture.workloads || typeof fixture.workloads !== "object") {
    return fixture;
  }

  const workloadIds = Object.keys(fixture.workloads).sort();
  const expectedWorkloadIds = Object.keys(WORKLOADS).sort();
  if (
    workloadIds.length !== expectedWorkloadIds.length ||
    workloadIds.some((id, index) => id !== expectedWorkloadIds[index])
  ) {
    throw fixtureError(
      `workloads must contain exactly ${expectedWorkloadIds.join(", ")}`,
    );
  }

  for (const [id, workload] of Object.entries(WORKLOADS)) {
    const slots = fixture.workloads[id];
    const expectedSlots = workload.warmups + workload.repetitions;
    if (!Array.isArray(slots) || slots.length !== expectedSlots) {
      throw fixtureError(
        `${id} must contain ${expectedSlots} scheduled slots; received ${slots?.length ?? 0}`,
      );
    }

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const attempts = slots[slotIndex];
      const isWarmup = workload.warmups > 0 && slotIndex < workload.warmups;
      const maximumAttempts = isWarmup ? 1 : 1 + MAX_RETRIES;
      if (
        !Array.isArray(attempts) ||
        attempts.length < 1 ||
        attempts.length > maximumAttempts
      ) {
        throw fixtureError(
          `${id} slot ${slotIndex + 1} must contain 1` +
            (maximumAttempts > 1 ? `-${maximumAttempts}` : "") +
            ` attempt responses; received ${attempts?.length ?? 0}`,
        );
      }
    }
  }

  return fixture;
}
