export class WorkspaceCalendarVerificationFailure extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("\n      "));
    this.name = "WorkspaceCalendarVerificationFailure";
    this.problems = [...problems];
  }
}

/**
 * The Calendar adapter can receive a successful POST and then reject the
 * provider receipt (for example, a wrong organizer or a missing Meet link).
 * Those errors carry the deterministic event id. Compensate through the same
 * cancellation adapter so a red verifier never quietly leaves its test invite
 * on the shared calendar.
 */
export async function cleanupWorkspaceCalendarFailure(args: {
  eventId?: string;
  cancel: (eventId: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<string | null> {
  if (!args.eventId) return null;
  const log = args.log || console.error;
  try {
    await args.cancel(args.eventId);
    log(`      cancelled ${args.eventId} after failed verification`);
    return null;
  } catch (error) {
    const problem = `cleanup failed for ${args.eventId}; remove it by hand: ${String(error)}`;
    log(`      ${problem}`);
    return problem;
  }
}

/**
 * Cleanup is part of the proof, not best-effort housekeeping. A verifier that
 * leaves its synthetic invite behind cannot report PASS: it did not complete
 * the same create/delete contract used by continuous health.
 */
export async function finishWorkspaceCalendarVerification(args: {
  eventId: string;
  problems: string[];
  cancel: () => Promise<void>;
  log?: (message: string) => void;
}): Promise<void> {
  const log = args.log || console.log;
  try {
    await args.cancel();
    log("      cancelled");
  } catch (error) {
    const problem = `cleanup failed for ${args.eventId}; remove it by hand: ${String(error)}`;
    args.problems.push(problem);
    log(`      ${problem}`);
  }

  if (args.problems.length) {
    throw new WorkspaceCalendarVerificationFailure(args.problems);
  }
  log("\nPASS — the workspace calendar booked, provisioned Meet, invited attendees, and cleaned up.");
}
