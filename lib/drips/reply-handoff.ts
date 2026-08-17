/**
 * lib/drips/reply-handoff.ts — when a Live Sub answers, stop the drip and get a
 * human into the conversation.
 *
 * Adon, 2026-08-17: "Once we have them answering, it should delegate it to our
 * agent... they can then log in to their Legacy account and take over the rest
 * of the text. Whether we do that through an email or a telegram bridge, it
 * doesn't matter. I think we should do both."
 *
 * Runs after the inbound sync, on the same 30-minute cadence. The decision
 * itself lives in reply-handoff-core.ts; this file is the I/O.
 *
 * WHAT IT GUARANTEES, in order of how badly each would hurt:
 *
 *   1. A merchant who replies stops receiving the drip. Before this, nothing
 *      cancelled on a reply, so someone who answered would still get the day-2,
 *      day-4, day-7 and day-11 texts while a human was mid-conversation on the
 *      same number.
 *   2. A human is told, on both channels, with enough to act on and a pointer
 *      to WHERE to act (the Legacy account, not the SunBiz one).
 *   3. It pages once per merchant. The provider resends and this sync is
 *      re-runnable by design, so the marker is written BEFORE the notification
 *      and a second pass reads it and stays quiet.
 *
 * Ordering is deliberate: CANCEL first, then mark, then notify. A crash between
 * cancel and notify leaves a merchant un-dripped and un-announced, which a
 * human notices. The reverse order would leave them announced and still being
 * dripped, which nobody notices until the merchant complains.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram, escapeTelegramHtml } from "@/lib/notify/telegram";
import { detectOptOut } from "@/lib/sms/compliance";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { decideHandoff, handoffSummary } from "./reply-handoff-core";

type Db = ReturnType<typeof getServiceSupabase>;

export type HandoffResult = {
  scanned: number;
  handed: string[];
  optedOut: string[];
  skipped: number;
  errors: string[];
};

/** Where an agent picks the conversation up. Named explicitly because it is
 *  NOT the account most of the team lives in — Live Subs are on the Legacy
 *  parent's AI Follow-Up sub-account, and sending someone to the wrong inbox
 *  to find a live merchant is the whole failure this notification prevents. */
const TAKEOVER_HINT =
  "Take it over in TextTorrent under the Legacy account, AI Follow-Up sub-account (submissions@sunbizfunding.com).";

/** Who gets the email copy. Adon asked for both channels: "whether we do that
 *  through an email or a telegram bridge, it doesn't matter. I think we should
 *  do both." Telegram is the one that gets read on a phone; the email is the
 *  one that survives, is searchable, and can be forwarded to whoever picks the
 *  merchant up. Comma-separated so a second agent is an env change. */
function handoffRecipients(): string[] {
  return (process.env.DRIP_HANDOFF_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

/**
 * Cancel a lead's remaining SMS drip steps.
 *
 * Scoped to `scheduled` rows: a row mid-send must not be yanked out from under
 * the sender, and already-terminal rows are none of our business.
 */
async function cancelRemaining(db: Db, tenantId: string, leadId: string): Promise<number> {
  const r = await db
    .from("drip_runs")
    .update({ status: "cancelled", last_error: "replied: handed to an agent" })
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("channel", "sms")
    .eq("status", "scheduled")
    .select("id");
  if (r.error) throw new Error(`cancel failed: ${r.error.message}`);
  return r.data?.length ?? 0;
}

/**
 * Look for merchants who have answered, and hand each one to a human.
 *
 * `sinceHours` bounds the scan rather than tracking a cursor: the marker on the
 * lead is what makes this idempotent, so a wide window costs a few extra reads
 * and cannot double-page. A cursor that drifted would silently skip replies,
 * which is the expensive direction.
 */
export async function processReplyHandoffs(
  tenantId: string,
  opts: { sinceHours?: number; notify?: boolean } = {},
): Promise<HandoffResult> {
  const db = getServiceSupabase();
  const since = new Date(Date.now() - (opts.sinceHours ?? 48) * 3_600_000).toISOString();
  const notify = opts.notify !== false;
  const out: HandoffResult = { scanned: 0, handed: [], optedOut: [], skipped: 0, errors: [] };

  const inbound = await db
    .from("lead_interactions")
    .select("id, lead_id, content, created_at")
    .eq("tenant_id", tenantId)
    .eq("type", "sms_received")
    .eq("direction", "inbound")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (inbound.error) {
    out.errors.push(`inbound read failed: ${inbound.error.message}`);
    return out;
  }

  // Newest first, one pass per lead. A merchant who sent three messages is one
  // handoff, and the newest is the one worth showing an agent.
  const seen = new Set<string>();
  const rows = (inbound.data || []) as Array<{ id: string; lead_id: string; content: string | null; created_at: string }>;

  for (const row of rows) {
    if (!row.lead_id || seen.has(row.lead_id)) continue;
    seen.add(row.lead_id);
    out.scanned += 1;

    try {
      const leadR = await db
        .from("tenant_records")
        .select("id, data")
        .eq("tenant_id", tenantId)
        .eq("id", row.lead_id)
        .maybeSingle();
      const data = ((leadR.data as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;

      const opt = detectOptOut(row.content ?? "");
      const decision = decideHandoff({
        body: row.content ?? "",
        inbound: true,
        optedOut: opt.optOut,
        // "likely" means the detector inferred it from natural language rather
        // than matching a regulatory keyword. Honoured either way; this only
        // decides whether a human is asked to confirm.
        optOutAmbiguous: opt.confidence === "likely",
        alreadyHandedOff: Boolean(data.drip_handoff_at),
      });

      if (decision.action === "ignore") {
        out.skipped += 1;
        continue;
      }

      // Both remaining outcomes end the drip. An opt-out is handled by the
      // suppression path for future sends; cancelling here stops the rows that
      // are already queued, which suppression alone would not.
      const cancelled = await cancelRemaining(db, tenantId, row.lead_id);

      if (decision.action === "opt_out") {
        out.optedOut.push(row.lead_id);
        // An EXPLICIT "STOP" needs no human: nothing to take over, and paging
        // on those is how a lane gets muted. A natural-language opt-out is the
        // ambiguous one and detectOptOut's own contract routes it to review, so
        // it falls through to the notification below.
        if (!decision.notifyAgent) continue;
      }

      // MARK BEFORE NOTIFYING. If the notification throws, the next pass sees
      // the marker and stays quiet rather than paging again — an un-notified
      // handoff is recoverable from the record, a duplicate page is noise that
      // trains people to ignore the lane.
      const marked = await db
        .from("tenant_records")
        .update({ data: { ...data, drip_handoff_at: new Date().toISOString(), drip_handoff_reason: decision.reason } })
        .eq("tenant_id", tenantId)
        .eq("id", row.lead_id);
      // The adapter RETURNS errors rather than throwing them. Ignoring this
      // would page on every 30-minute scan forever, because the marker that
      // makes the next pass quiet was never written — the notification would
      // be the only thing that "worked".
      if (marked.error) {
        out.errors.push(`${row.lead_id}: marker not written (${marked.error.message}); not notifying`);
        continue;
      }

      if (decision.action === "handoff") out.handed.push(row.lead_id);

      if (notify) {
        const phone = typeof data.phone === "string" ? data.phone : "unknown";
        const summary = handoffSummary({
          businessName: typeof data.business_name === "string" ? data.business_name : null,
          contactName: typeof data.contact_name === "string" ? data.contact_name : null,
          phone,
          body: row.content ?? "",
        });
        const stopped = `Drip stopped${cancelled ? ` (${cancelled} step${cancelled === 1 ? "" : "s"} cancelled)` : ""}.`;
        const heading = decision.action === "opt_out"
          ? "🚫 <b>Live Sub asked to stop</b>"
          : "💬 <b>Live Sub replied</b>";

        // Every untrusted field escaped: the body is merchant-authored text
        // going into Telegram HTML mode.
        await sendTelegram(
          `${heading}\n${escapeTelegramHtml(summary)}\n\n` +
            `<i>${stopped} ${escapeTelegramHtml(
              decision.action === "opt_out"
                ? "Suppressed. Worth a human eye — this was read as an opt-out from natural language, not a STOP keyword."
                : TAKEOVER_HINT,
            )}</i>`,
          { lane: "sunbiz-ops" },
        ).catch(() => undefined);

        // Email copy. Plaintext only: this is an internal note, and the whole
        // point is that it survives, is searchable, and can be forwarded to
        // whoever picks the merchant up.
        for (const to of handoffRecipients()) {
          await sendGmail({
            tenantId,
            to,
            subject:
              decision.action === "opt_out"
                ? `Live Sub opted out: ${phone}`
                : `Live Sub replied: ${phone}`,
            body: `${summary}\n\n${stopped}\n${decision.action === "opt_out" ? "Suppressed automatically. This was inferred from natural language rather than a STOP keyword, so it is worth confirming." : TAKEOVER_HINT}\n`,
          }).catch((e) => {
            // Never let the email take the run down — Telegram has already
            // fired and the handoff is recorded either way.
            out.errors.push(`email to ${to}: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }
    } catch (err) {
      out.errors.push(`${row.lead_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return out;
}
