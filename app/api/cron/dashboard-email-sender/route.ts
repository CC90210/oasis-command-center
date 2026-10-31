/**
 * GET+POST /api/cron/dashboard-email-sender
 *
 * Cloud replacement for the retired PC dashboard-email consumer. It owns only
 * OASIS drawer emails and the AI-audit transactional EMAIL outbox. Bulk email
 * and SMS have different senders and are never selected here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { cronPauseGate } from "@/lib/automations/cron-switches";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { isDryRun } from "@/lib/integrations/send-mode";
import { sendOasisSharedGmail } from "@/lib/integrations/oasis-shared-gmail-send";
import {
  dashboardEmailCredentialReadiness,
  dashboardEmailMetadata,
  dashboardEmailSenderEnabled,
  runDashboardEmailSender,
} from "@/lib/leads/dashboard-email-sender";
import { SupabaseDashboardEmailSenderStore } from "@/lib/leads/dashboard-email-sender-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const paused = await cronPauseGate(req);
  if (paused) return paused;

  // The job-specific switch is deliberately read before any queue or
  // credential-store access. An explicit dry-run may inspect but never mutate.
  const explicitDryRun = req.nextUrl.searchParams.get("dry_run") === "1";
  const enabled = dashboardEmailSenderEnabled();
  if (!enabled && !explicitDryRun) {
    return NextResponse.json({
      ok: true,
      mode: "off",
      reason: "OASIS_DASHBOARD_EMAIL_SENDER_FORWARD is not enabled",
    });
  }

  // The established dashboard-wide email switch remains authoritative. The
  // new job switch cannot silently make a test-mode channel live.
  const dryRun = explicitDryRun || isDryRun("email");
  const readiness = dashboardEmailCredentialReadiness();
  if (!dryRun && !readiness.ready) {
    return NextResponse.json(
      {
        ok: false,
        mode: "blocked",
        error: "dashboard_email_sender_credentials_not_ready",
        detail: readiness.reason,
        ...(readiness.missing ? { missing: readiness.missing } : {}),
      },
      { status: 503 },
    );
  }

  const db = getServiceSupabase();
  const store = new SupabaseDashboardEmailSenderStore(db);
  try {
    const summary = await runDashboardEmailSender({
      store,
      dryRun,
      send: async ({ row, idempotencyKey }) => {
        const metadata = dashboardEmailMetadata(row.metadata);
        const requestedBy = typeof metadata.requested_by_email === "string"
          ? metadata.requested_by_email.trim()
          : "";
        const copy = EMAIL_RE.test(requestedBy) ? requestedBy : null;
        const signer = resolveSignerForOperator(copy || "", { brand: "oasis" });
        return sendOasisSharedGmail({
          tenantId: row.tenant_id,
          to: (row.to_email || "").trim(),
          ...(copy ? { cc: copy, replyTo: copy } : {}),
          subject: (row.subject || "").trim() || "(no subject)",
          body: (row.content || row.content_preview || "").trim(),
          signer,
          idempotencyKey,
        });
      },
    });
    const terminalFailure = summary.failed + summary.delivery_unknown + summary.transition_failures > 0;
    if (terminalFailure) {
      console.error("[dashboard-email-sender] terminal queue outcome", summary);
    } else {
      console.log("[dashboard-email-sender] run", summary);
    }
    return NextResponse.json(
      {
        ok: !terminalFailure,
        ...summary,
        credential_ready: readiness.ready,
        ...(readiness.ready ? { from_address: readiness.fromAddress } : { credential_reason: readiness.reason }),
      },
      // A durable terminal queue outcome is not a transient route crash. Use a
      // non-retryable 4xx so the cron Worker records this tick red once instead
      // of retrying and overwriting it with a green no-work result.
      { status: terminalFailure ? 409 : 200 },
    );
  } catch (error) {
    console.error("[dashboard-email-sender] run failed", error);
    return NextResponse.json(
      {
        ok: false,
        error: "dashboard_email_sender_failed",
        detail: error instanceof Error ? error.message.slice(0, 300) : "unknown failure",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
