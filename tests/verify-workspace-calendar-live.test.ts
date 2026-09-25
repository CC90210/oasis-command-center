import assert from "node:assert/strict";
import {
  cleanupWorkspaceCalendarFailure,
  finishWorkspaceCalendarVerification,
} from "../scripts/verify-workspace-calendar-live-core";

async function run() {
  const output: string[] = [];
  const problems: string[] = [];

  await assert.rejects(
    finishWorkspaceCalendarVerification({
      eventId: "event-cleanup-fails",
      problems,
      cancel: async () => {
        throw new Error("synthetic delete rejection");
      },
      log: (message) => output.push(message),
    }),
    /cleanup failed.*event-cleanup-fails/i,
    "cleanup failure must reject the verifier so the CLI exits nonzero",
  );

  assert.match(problems.join("\n"), /cleanup failed.*event-cleanup-fails/i);
  assert.equal(
    output.some((line) => /PASS/.test(line)),
    false,
    "a failed cleanup must never print PASS",
  );

  const compensated: string[] = [];
  const compensationProblem = await cleanupWorkspaceCalendarFailure({
    eventId: "event-created-before-adapter-failure",
    cancel: async (eventId) => {
      compensated.push(eventId);
    },
    log: (message) => output.push(message),
  });
  assert.deepEqual(
    compensated,
    ["event-created-before-adapter-failure"],
    "an adapter failure carrying an event id must trigger compensating deletion",
  );
  assert.equal(compensationProblem, null);

  const failedCompensation = await cleanupWorkspaceCalendarFailure({
    eventId: "event-compensation-fails",
    cancel: async () => {
      throw new Error("synthetic compensation rejection");
    },
    log: (message) => output.push(message),
  });
  assert.match(
    failedCompensation || "",
    /cleanup failed.*event-compensation-fails.*synthetic compensation rejection/i,
    "a failed compensating delete must be reported alongside the original create failure",
  );

  const verifierSource = (await import("node:fs")).readFileSync(
    "scripts/verify-workspace-calendar-live.ts",
    "utf8",
  );
  assert.match(
    verifierSource,
    /cleanupWorkspaceCalendarFailure\([\s\S]*eventId:\s*error\.eventId/,
    "the live verifier catch path must compensate an adapter error that carries a provider event id",
  );

  console.log("verify-workspace-calendar-live: cleanup and failure compensation are fatal-safe OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
