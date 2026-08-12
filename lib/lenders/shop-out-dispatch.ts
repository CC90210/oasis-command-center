import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendSunbizLenderMail } from "@/lib/integrations/sunbiz-lender-mail-send";
import type { ShopOutAttachment } from "@/lib/lenders/shop-out";

/**
 * Dispatch every pending SunBiz lender thread on an application, in-process.
 *
 * This replaces the bridge -> VPS -> send_gateway chain for the SunBiz network.
 * See lib/integrations/sunbiz-lender-mail-send.ts for why: the bytes are in R2,
 * the web app is the process that has R2 and the SMTP credential, and the VPS
 * has neither. Every link removed is a link that cannot silently break.
 *
 * Concurrency: each row is CLAIMED with a conditional update (pending -> sending)
 * before anything is sent, and only a row we actually won is dispatched. The VPS
 * shop_out_sender cron polls the same pending rows every minute, so without the
 * claim both could send and a funder would receive the same deal twice. Losing
 * the claim is not an error — it means someone else owns that row.
 */

export type DispatchOutcome = {
  status: "sent" | "partial" | "error" | "skipped";
  sent_count: number;
  failed_count: number;
  total_pending: number;
  message?: string;
  failures: Array<{ thread_id: string; lender: string; reason: string }>;
};

type ThreadRow = {
  id: string;
  lender_id: string;
  subject: string | null;
  body_template: string | null;
  cc_emails: unknown;
  attachments: unknown;
};

/**
 * The conversation anchor every lender email on this deal shares.
 *
 * Derived from the application id rather than minted per run, deliberately: a
 * retry, a second wave of lenders next week, and the original send all produce
 * the SAME value, so they all land in the one existing inbox thread. A random
 * per-batch id would start a fresh conversation every time Retry was pressed,
 * which is the flooding this exists to prevent.
 *
 * It is a synthetic id — no message with this id is ever sent. It appears only
 * in References, which is a grouping hint, not a claim that it exists.
 */
function dealThreadRootId(applicationId: string): string {
  return `<shopout-${applicationId}@sunbizfunding.com>`;
}

/** Pick the submission address the SOP specifies, else the primary contact. */
function resolveRecipient(data: Record<string, unknown>): string | null {
  const submission = Array.isArray(data.submission_emails)
    ? (data.submission_emails as unknown[]).filter(
        (e): e is string => typeof e === "string" && e.includes("@"),
      )
    : [];
  const contact =
    typeof data.contact === "string" && data.contact.includes("@") ? data.contact : null;
  return submission.find((e) => /submission|submit/i.test(e)) || submission[0] || contact;
}

export async function dispatchPendingSunbizThreads(input: {
  tenantId: string;
  applicationId: string;
  signerName?: string;
}): Promise<DispatchOutcome> {
  const db = getServiceSupabase();
  const empty: DispatchOutcome = {
    status: "skipped",
    sent_count: 0,
    failed_count: 0,
    total_pending: 0,
    failures: [],
  };

  const pendingRes = await db
    .from("application_lender_threads")
    .select("id, lender_id, subject, body_template, cc_emails, attachments")
    .eq("tenant_id", input.tenantId)
    .eq("application_id", input.applicationId)
    .eq("email_identity", "sunbiz")
    .eq("status", "pending");

  if (pendingRes.error) {
    return { ...empty, status: "error", message: `thread_read_failed: ${pendingRes.error.message}` };
  }
  const pending = (pendingRes.data || []) as ThreadRow[];
  if (pending.length === 0) {
    return { ...empty, message: "no pending threads" };
  }

  const failures: DispatchOutcome["failures"] = [];
  let sent = 0;

  for (const thread of pending) {
    // Claim it. `.eq("status","pending")` makes this conditional: if the VPS
    // cron already flipped the row, we update nothing and skip it rather than
    // sending a second copy.
    const claim = await db
      .from("application_lender_threads")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", thread.id)
      .eq("status", "pending")
      .select("id");
    if (claim.error || !(claim.data || []).length) continue;

    const lenderRes = await db
      .from("tenant_records")
      .select("data")
      .eq("id", thread.lender_id)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    const lenderData = ((lenderRes.data as { data?: Record<string, unknown> } | null)?.data ||
      {}) as Record<string, unknown>;
    const lenderName = String(lenderData.name || "(unnamed lender)");
    const recipient = resolveRecipient(lenderData);

    const fail = async (reason: string) => {
      failures.push({ thread_id: thread.id, lender: lenderName, reason });
      await db
        .from("application_lender_threads")
        .update({
          status: "error",
          last_error: reason.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", thread.id);
    };

    if (!recipient) {
      await fail("missing lender submission/contact email");
      continue;
    }

    const result = await sendSunbizLenderMail({
      to: recipient,
      cc: Array.isArray(thread.cc_emails) ? (thread.cc_emails as string[]) : undefined,
      subject: thread.subject || "New Deal",
      text: thread.body_template || "New submission attached.",
      tenantId: input.tenantId,
      attachments: (Array.isArray(thread.attachments)
        ? thread.attachments
        : []) as ShopOutAttachment[],
      signerName: input.signerName,
      // Same anchor for every lender on this deal -> one inbox conversation.
      threadRootId: dealThreadRootId(input.applicationId),
    });

    if (!result.ok) {
      await fail(result.error);
      continue;
    }

    // Stamp the receipt in the SAME write that claims the send. A status
    // without evidence behind it is what shopout.sent_without_proof exists to
    // catch, and the sender is the only place that can supply it.
    const stamp = await db
      .from("application_lender_threads")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        gmail_thread_id: result.rfc822MessageId,
        last_message_id: result.rfc822MessageId,
        send_interaction_id: result.rfc822MessageId,
        last_error: null,
        // Clear the REPLY fields too. A successful send means this thread is
        // awaiting an answer to THIS message, so anything left in them
        // describes a previous attempt and is now false.
        //
        // Not hypothetical: the old VPS sender wrote its 500-char failure
        // traceback into last_response_summary, a column meant for the
        // LENDER's answer. Clearing last_error alone left that behind, and the
        // row renders `last_error || last_response_summary` — so six
        // successfully sent threads displayed a dead send_gateway stack trace
        // styled as the funder's response.
        last_response_summary: null,
        last_response_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", thread.id);
    if (stamp.error) {
      // The mail DID go out. Say so loudly rather than reporting a failure that
      // would prompt a retry and email the funder twice.
      console.error("[shop-out] SENT but could not stamp the row", {
        threadId: thread.id,
        error: stamp.error.message,
      });
    }
    sent += 1;
  }

  const failed = failures.length;
  const total = pending.length;
  const status: DispatchOutcome["status"] =
    sent > 0 && failed === 0 ? "sent" : sent > 0 ? "partial" : failed > 0 ? "error" : "skipped";

  return {
    status,
    sent_count: sent,
    failed_count: failed,
    total_pending: total,
    failures,
    message:
      failed > 0
        ? failures.map((f) => `${f.lender}: ${f.reason}`).join(" · ").slice(0, 400)
        : undefined,
  };
}
