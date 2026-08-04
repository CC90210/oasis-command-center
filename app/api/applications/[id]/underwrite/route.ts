/**
 * POST /api/applications/[id]/underwrite — RETIRED 2026-08-04.
 *
 * Phase 7.3's underwriting entry point, superseded by
 * POST /api/applications/[id]/underwriting/run.
 *
 * To be accurate about what it did: it never ran or enqueued anything itself.
 * It gathered the lead's bank-statement attachments and returned a
 * `bridge_tool_payload` plus an `operator_prompt` for a human (or Solara) to
 * hand to the legacy `underwriting_run` bridge tool, which drove
 * statement_parser → debt_detector → sales_angle on the operator's machine and
 * wrote `application.data.underwriting_jsonb`.
 *
 * It is retired for two reasons.
 *
 * FIRST, it is a second way in. Adon, 2026-08-04: underwriting is
 * operator-initiated only, and old files that were never underwritten must not
 * get queued and re-run, because that is spend with nothing asked for at the end
 * of it. The shared enqueue now refuses any run without a named operator and
 * holds the in-flight 409 guard; this route reached the legacy chain around
 * both, and wrote to a different place than the `application_underwriting` table
 * everything else reads.
 *
 * SECOND, its own header documented an automatic caller: "auto-fired by the
 * sequence-runner daemon when it observes a BRAVO_RECORD_STATUS_CHANGED event
 * with entity=application + to=submitted". Nothing in this repo calls it, and
 * `resolveTenantId()` needs a session so a daemon could not have reached it
 * unauthenticated — but a documented automatic path into the pipeline being
 * replaced is not something to leave lying next to the cutover.
 *
 * Answering 410 rather than deleting the file: an external caller still pointing
 * here gets a legible reason instead of a bare 404 that reads like a deploy
 * problem. tests/underwriting-manual-only.test.ts keeps it retired.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      ok: false,
      error: "route_retired",
      detail:
        "Underwriting is operator-initiated only. Use the Start underwriting / Re-run button on the lead, " +
        "which posts to /api/applications/[id]/underwriting/run. Retired 2026-08-04.",
    },
    { status: 410 },
  );
}
