"use client";

/**
 * useAudit — one lead's website audit, fetched once and shared.
 *
 * Extracted from WebsiteComparison.tsx (2026-08-23) because CallMode.tsx needs
 * the SAME data rendered at a different size, and two components fetching the
 * same endpoint through two hand-rolled effects is how the two drift: one gets
 * a race-condition fix, the other doesn't, and the bug reappears in the view
 * nobody re-read.
 *
 * THE RACE THIS GUARDS, in full, because it is subtle and it matters here more
 * than almost anywhere else in the app: `alive` is re-checked AFTER the body is
 * parsed, immediately before setState -- NOT once when the fetch resolves. A
 * check before `await r.json()` only covers the header round-trip. Open lead A,
 * then lead B while A's body is still streaming, and A's late body lands after
 * B's smaller/faster body and overwrites it. The panel then shows lead A's
 * website findings under lead B's business name. In Call Mode, where a rep
 * advances through a queue fast enough to outrun a slow response, that is a rep
 * reading one business's problems aloud to a different business. The same
 * invariant is documented in WebLeadDetail.tsx and WebLeadsBrowser.tsx.
 */

import { useEffect, useState } from "react";
// Type-only: lib/web-leads/audit.ts imports getServiceSupabase() (next/headers,
// server-only). A value import here pulls that whole module into the client
// bundle and fails the build.
import type { AuditResult, CheckResult, DimensionProfile } from "@/lib/web-leads/audit";

export type AuditFetch =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; audit: AuditResult };

export function useAudit(leadId: string): AuditFetch {
  const [state, setState] = useState<AuditFetch>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/audit`)
      .then(async (r) => {
        if (!r.ok) {
          if (alive) setState({ status: "error", message: "Could not load website score." });
          return;
        }
        const body = await r.json();
        // See the module header: this check must be here, after the parse.
        if (alive) setState({ status: "ready", audit: body as AuditResult });
      })
      .catch(() => {
        if (alive) setState({ status: "error", message: "Could not load website score." });
      });
    return () => { alive = false; };
  }, [leadId]);

  return state;
}

/**
 * The failed checks worth saying out loud, largest point value first.
 *
 * Pulled from `checks` (which carries the rep-facing label) rather than a
 * dimension's `missing` (codes only). `limit` differs by surface: the detail
 * panel shows four, Call Mode shows three -- a rep mid-call reads the top of a
 * list and a fourth item is one the phone conversation has already moved past.
 */
export function biggestGaps(dimensions: DimensionProfile[], limit = 4): CheckResult[] {
  return dimensions
    .flatMap((d) => d.checks.filter((c) => !c.has))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/**
 * The one sentence that describes a non-scored state, VERBATIM.
 *
 * Centralised so the table, the panel and Call Mode cannot drift into three
 * different phrasings of the same uncertainty -- and specifically so none of
 * them can shorten one into a badge. "We could not check this site" is a
 * statement about OUR crawler, not a finding about their business: a site we
 * were blocked from may be excellent. Rendering that as a dash, a zero, or a
 * neutral-looking blank is the failure mode this whole feature is built to
 * avoid. See lib/web-leads/audit.ts.
 */
export const SCORE_STATE_WORDS: Record<string, string> = {
  no_website: "No website found yet, needs checking",
  not_scored: "Not scored yet",
  unreachable: "We could not check this site",
};
