/**
 * lib/health/optout-checks.ts — the opt-out intake, estate-wide.
 *
 * /api/unsubscribe files an opt-out whose link brand is not pinned to a
 * workspace GLOBALLY (tenant_id NULL), and every sender honours a global row
 * (OCC #711). An unsigned link can opt out anyone. Each address bucket (an
 * IPv6 /64) may file 30 an hour, but a /48 holds 65,536 buckets, so the cap
 * bounds one source, not a campaign. Real volume is a handful a month.
 *
 * So this watches the whole estate's global web filings over the last hour and
 * pages past a ceiling (reviewer of #711, item 25). An alarm, never a refusal:
 * refusing would let an attacker block real opt-outs.
 *
 * Cleaning up after abuse: every row carries ip_address and added_at. Group
 * the window's global web rows by ip_address first, e.g.
 *   SELECT ip_address, count(*) FROM email_suppressions
 *   WHERE tenant_id IS NULL AND source = 'web_form' AND added_at >= '<from>'
 *   GROUP BY ip_address ORDER BY 2 DESC;
 * then remove only the abusive prefix's rows, with CC's yes: until proven
 * otherwise each row is somebody's opt-out.
 */

import "server-only";
import type { DripCheck } from "./drip-checks";

const iso = (ms: number) => new Date(ms).toISOString();

/** Global web opt-outs in an hour above which OASIS is paged. */
export const GLOBAL_WEB_OPTOUTS_PER_HOUR_CEILING = 25;

export const OPTOUT_CHECKS: DripCheck[] = [
  {
    id: "optouts.global_web_filings_hourly",
    severity: "high",
    lane: "operator",
    rule: { kind: "must_be_below", ceiling: GLOBAL_WEB_OPTOUTS_PER_HOUR_CEILING },
    // Estate-wide by nature (a global row has no workspace), so the tenant the
    // runner passes is ignored, as forms.submit_failures_open does.
    observe: async (db, _tenantId, endMs) => {
      try {
        const r = await db
          .from("email_suppressions")
          .select("id", { count: "exact", head: true })
          .is("tenant_id", null)
          .eq("source", "web_form")
          .gte("added_at", iso(endMs - 3_600_000))
          .lt("added_at", iso(endMs));
        if (r.error) return null;
        return r.count ?? 0;
      } catch {
        return null;
      }
    },
    describe: (r) =>
      `${r.observed} opt-outs from web links were filed for every sender in the last hour; a handful a month is normal. ` +
      `If it is abuse, group that hour's rows in email_suppressions (tenant_id NULL, source web_form) by ip_address, ` +
      `and remove only the abusive prefix's rows, with CC's yes (lib/health/optout-checks.ts).`,
  },
];
