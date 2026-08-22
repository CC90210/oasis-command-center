/**
 * The rule that stops the dashboard from arming a parked cron twin.
 *
 * Kept apart from the route so the decision itself is a pure function a test
 * can execute, rather than a branch a test can only read. The route does the
 * two lookups (each with the same filter its UPDATE uses) and hands the result
 * here; everything about WHETHER the write is allowed lives in this file.
 *
 * Why the write must not exist at all, rather than merely being hidden in the
 * UI: `cron_jobs.is_active` on a daemon-backed row is an interlock. Setting it
 * to 1 re-arms the shared scheduler's copy of the script AND makes the daemon
 * refuse its next boot — `scripts/integrations/ig_dm_daemon.py:cron_row_is_armed()`
 * reads exactly this flag and exits rather than become the second runner.
 * On 2026-08-20 two runners on the same script answered every prospect twice.
 *
 * See lib/automations/daemon-backed-crons.ts for which rows these are.
 */

import { daemonBackedCronForName } from "./daemon-backed-crons";

/**
 * What the caller found when it looked up the row's name.
 *
 * `ok: false` means the lookup FAILED — not that the row is absent. The two
 * are different and the difference is the whole point: an absent row is safe
 * to fall through on (the UPDATE 404s), an unreadable one is not, because
 * "probably not daemon-backed" is not a good enough reason to write a flag
 * that can take the setter offline.
 */
export type CronNameLookup = { ok: true; name: string | null } | { ok: false };

/** A refusal to send, or null when the write may proceed. */
export type ToggleRefusal = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Decide whether an `enabled` write may land on this row.
 *
 * Fails closed on an unreadable lookup, same posture the daemon itself takes:
 * it treats an unreadable registry as "do not start" rather than assuming the
 * coast is clear.
 */
export function daemonToggleRefusal(lookup: CronNameLookup): ToggleRefusal | null {
  if (!lookup.ok) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "daemon_guard_unreadable",
        message:
          "Couldn't verify whether this automation is run by a background process, " +
          "so nothing was changed. Try again in a moment.",
      },
    };
  }
  const backing = daemonBackedCronForName(lookup.name);
  if (!backing) return null;
  return {
    status: 409,
    body: {
      ok: false,
      error: "daemon_backed_cron_not_toggleable",
      daemon: {
        service: backing.service,
        process_name: backing.processName,
        label: backing.label,
      },
      message:
        `"${backing.cronName}" runs as the ${backing.processName} background process, not on ` +
        "the shared scheduler. Start or stop it from its own switch — arming this row would " +
        "put a second runner on the same script and stop the process from restarting.",
    },
  };
}
