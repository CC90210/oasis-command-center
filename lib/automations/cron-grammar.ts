// The ONE five-field cron grammar for every route that stores a schedule.
//
// Three hand-copied validators used to guard tenant_cron_jobs writes:
// app/api/cron-jobs/route.ts, app/api/cron-jobs/[id]/route.ts and
// app/api/automations/save-draft/route.ts. The third also accepted day names
// (MON-FRI). The bridge that runs those rows (CEO-Agent bravo_cli/cron_runner.py
// _parse_cron_field) int()s every piece of every field and swallows the
// ValueError, so a job saved as "0 9 * * MON-FRI" was stored, shown as On, and
// never fired once. One grammar, owned here, accepts exactly what that parser
// and lib/automations/schedule-plan.ts both read the same way:
//
//   *        every value                 */N      every Nth value
//   N        one value                   N-M      a range
//   N-M/S    every Sth value in a range   a,b,c    a list of N / N-M / N-M/S
//
// Deliberately refused, each because some reader would disagree with another:
//   - names (MON, JAN): cron_runner.py cannot parse them;
//   - a bare value with a step ("5/10"): cron_runner.py reads 5, other cron
//     readers read 5,15,25,...;
//   - a star inside a list ("*,5"): cron_runner.py int("*") never fires;
//   - out-of-range values, a zero step, or a backwards range: they parse, but
//     match nothing, so the job would never run.

import { expandNumericField } from "@/lib/automations/cron-schedule";

const LIST_PART = String.raw`\d+(?:-\d+(?:/\d+)?)?`;

/** Shape of one field. Bounds are checked separately by isValidCronExpr. */
export const CRON_FIELD = new RegExp(String.raw`^(?:\*|\*/\d+|${LIST_PART}(?:,${LIST_PART})*)$`);

/** minute, hour, day of month, month, day of week (0 and 7 are both Sunday). */
export const CRON_FIELD_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** True when `expr` is a five-field cron every reader of tenant_cron_jobs runs identically. */
export function isValidCronExpr(expr: unknown): boolean {
  if (typeof expr !== "string") return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((field, i) => {
    if (!CRON_FIELD.test(field)) return false;
    const [min, max] = CRON_FIELD_BOUNDS[i];
    return expandNumericField(field, min, max) !== null;
  });
}
