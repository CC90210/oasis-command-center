/**
 * lib/health/form-checks.ts — outcome checks for the public form intake.
 *
 * Born from the or() parser crash (#224, 2026-08-18): nine days of public-form
 * submissions destroyed pre-insert with no alert, because nothing watched the
 * intake path itself. The dead-letter table (146_form_submit_failures) now
 * captures every blocked submission; this check is what keeps it LOUD — red on
 * the 15-minute cron until a human closes every open row, recovery announced
 * by the runner like every other check.
 */

import "server-only";
import type { DripCheck } from "./drip-checks";

const iso = (ms: number) => new Date(ms).toISOString();
const OPEN_WINDOW_MS = 48 * 3_600_000;

export const FORM_CHECKS: DripCheck[] = [
  {
    // A blocked merchant application that nobody has recovered yet. The inline
    // page from captureSubmitFailure is the instant signal; this is the one
    // that cannot be missed or forgotten, because it re-asserts on the ladder
    // until recovered_at is set on every row.
    id: "forms.submit_failures_open",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    // The dead-letter table is estate-wide (tenant_slug is advisory text from
    // the failure itself), so this check deliberately ignores the tenantId the
    // runner passes: a blocked application is a blocked application.
    observe: async (db, _tenantId, endMs) => {
      try {
        const r = await db
          .from("form_submit_failures")
          .select("id", { count: "exact", head: true })
          .is("recovered_at", null)
          .gte("created_at", iso(endMs - OPEN_WINDOW_MS))
          .lt("created_at", iso(endMs));
        if (r.error) return null;
        return r.count ?? 0;
      } catch {
        return null;
      }
    },
    describe: (r) =>
      `${r.observed} blocked form submission(s) in the last 48h with no recovery recorded. ` +
      `Each row in form_submit_failures holds the merchant's answers — contact them, then set recovered_at. ` +
      `This exact silence cost nine days of dotted-email applications.`,
  },
];
