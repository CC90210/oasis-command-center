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
import { cooloffDays } from "./optout-cooloff-core";

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
 * Have we already recorded an opt-out at or after this message?
 *
 * Timestamp comparison rather than a boolean, so a SECOND, later opt-out is
 * still processed — someone can say stop, be re-engaged by a human, and say
 * stop again, and the later one must land.
 *
 * An unreadable stored stamp is treated as NOT covering this message: we would
 * rather re-announce once than silently drop a genuine opt-out.
 */
function optOutAlreadyRecorded(storedAt: unknown, messageAt: string): boolean {
  if (!storedAt) return false;
  const stored = Date.parse(String(storedAt));
  const msg = Date.parse(messageAt);
  if (!Number.isFinite(stored) || !Number.isFinite(msg)) return false;
  return stored >= msg;
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

  // An OPT-OUT anywhere in the window wins, even when a newer message follows
  // it. "STOP" then "actually hold on" used to mean the STOP row was skipped by
  // the newest-only pass, so the lead was never stamped, the email cool-off
  // never started and nobody was told. Codex caught it. Scanned per lead before
  // choosing which single message to act on.
  const optOutRow = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!r.lead_id || optOutRow.has(r.lead_id)) continue;
    if (detectOptOut(r.content ?? "").optOut) optOutRow.set(r.lead_id, r);
  }

  for (const newest of rows) {
    if (!newest.lead_id || seen.has(newest.lead_id)) continue;
    seen.add(newest.lead_id);
    out.scanned += 1;
    // Act on the opt-out if there is one; otherwise on the newest message.
    const row = optOutRow.get(newest.lead_id) ?? newest;

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
        // Already stamped at or after this message? Then we acted on it on an
        // earlier scan. Without this the opt-out's deliberate bypass of
        // alreadyHandedOff re-announces the same STOP every 30 minutes for the
        // whole 48h window.
        optOutAlreadyRecorded: optOutAlreadyRecorded(data.sms_opt_out_at, row.created_at),
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

      if (decision.action === "opt_out") out.optedOut.push(row.lead_id);

      // ONE write, not two. Both patches spread `data`, so writing them
      // separately means the second read-modify-write silently discards the
      // first — and the field it would discard is the opt-out stamp, whose
      // whole job is to stop us emailing someone who said stop.
      const patch: Record<string, unknown> = {
        ...data,
        drip_handoff_at: new Date().toISOString(),
        drip_handoff_reason: decision.reason,
      };
      if (decision.action === "opt_out") {
        // The phone suppression list already stops texting permanently, but it
        // is keyed by NUMBER and the email drip reads a different list — so
        // without this stamp a merchant can reply STOP at 4pm and get a
        // Bluerise follow-up at 9am. emailCooloff reads it.
        patch.sms_opt_out_at = row.created_at || new Date().toISOString();
        patch.sms_opt_out_kind = opt.confidence;
      }

      // MARK BEFORE NOTIFYING. If the notification throws, the next pass sees
      // the marker and stays quiet rather than paging again — an un-notified
      // handoff is recoverable from the record, a duplicate page is noise that
      // trains people to ignore the lane.
      const marked = await db
        .from("tenant_records")
        .update({ data: patch })
        .eq("tenant_id", tenantId)
        .eq("id", row.lead_id);
      // The adapter RETURNS errors rather than throwing them. Ignoring this
      // would page every 30 minutes forever because the marker was never
      // written — and for an opt-out it would also mean the cool-off stamp is
      // missing, so the email drip would carry on.
      if (marked.error) {
        out.errors.push(`${row.lead_id}: record not updated (${marked.error.message}); not notifying`);
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

        // THREE audiences, not two. Adon asked to be told about opt-outs too
        // ("we have to be alerted about this as well"), and then narrowed the
        // review case: "if it's in natural language... it needs to have human
        // review." So an explicit STOP is an FYI, an inferred one is a task.
        const ambiguous = decision.action === "opt_out" && opt.confidence === "likely";
        const heading = ambiguous
          ? "\u{26A0}\u{FE0F} <b>Possible opt-out \u2014 needs human review</b>"
          : decision.action === "opt_out"
            ? "\u{1F6AB} <b>Live Sub said STOP</b>"
            : "\u{1F4AC} <b>Live Sub replied</b>";
        const action = ambiguous
          ? `Suppressed and the drip is stopped, but this was READ as an opt-out from ordinary words, not the word STOP. Confirm that is what they meant. If it was not, clear the suppression. Email is also on hold for ${cooloffDays()} days.`
          : decision.action === "opt_out"
            ? `Texting is suppressed permanently. Email is on hold for ${cooloffDays()} days so we are not seen to switch channels on someone who asked us to stop. No action needed.`
            : TAKEOVER_HINT;

        // Every untrusted field escaped: the body is merchant-authored text
        // going into Telegram HTML mode.
        await sendTelegram(
          `${heading}\n${escapeTelegramHtml(summary)}\n\n` +
            `<i>${stopped} ${escapeTelegramHtml(action)}</i>`,
          { lane: "sunbiz-ops" },
        ).catch(() => undefined);

        // Email copy. Plaintext only: this is an internal note, and the whole
        // point is that it survives, is searchable, and can be forwarded to
        // whoever picks the merchant up.
        for (const to of handoffRecipients()) {
          await sendGmail({
            tenantId,
            to,
            subject: ambiguous
              ? `NEEDS REVIEW - possible opt-out: ${phone}`
              : decision.action === "opt_out"
                ? `Live Sub said STOP: ${phone}`
                : `Live Sub replied: ${phone}`,
            body: `${summary}\n\n${stopped}\n${action}\n`,
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
