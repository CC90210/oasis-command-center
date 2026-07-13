/**
 * lib/integrations/cold-sending.ts — the COLD/marketing sending brain.
 *
 * The whole point: cold email blasts must go out from SEPARATE domains (a pool
 * of dedicated cold mailboxes), NEVER from the primary sunbizfunding.com domain
 * used for real deal/lender/relationship mail. This module is what "knows" that
 * in the backend:
 *   - registry: cold_sending_mailboxes (migration 109), app passwords encrypted
 *   - router:   resolveSendRoute() — cold → cold pool, else BLOCK; warm → primary
 *   - sender:   sendColdEmail() — picks a ready+under-cap mailbox, runs the
 *               suppression + never-mention-lenders gates (fail closed), sends
 *               via that cold mailbox's own SMTP, and increments its daily cap.
 *
 * FAIL CLOSED: if there is no ready cold mailbox, a cold send is BLOCKED. It must
 * never silently fall back to the primary domain — that would defeat the entire
 * reputation-isolation strategy. Adon provisions the domains/mailboxes via the
 * /api/cold-sending/mailboxes route as he buys them.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { encryptField, decryptField } from "@/lib/field-encryption";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { buildTrackedHtml, unsubscribeApiUrl } from "@/lib/email/tracked-html";

export type SendClass = "cold" | "warm";

export type ColdMailboxRow = {
  id: string;
  tenant_id: string;
  domain: string;
  address: string;
  provider: string;
  app_password_enc: string | null;
  daily_cap: number;
  sends_today: number;
  sends_date: string | null;
  last_send_at: string | null;
  warmup_status: string;
  active: boolean;
};

// CAN-SPAM/CASL footer for cold outreach: physical postal address + a clear opt-out.
// (A List-Unsubscribe header is also set on the send for the one-click requirement.)
const COLD_FOOTER =
  "\n\n---\nSunBiz Funding LLC\n1 East Broward Blvd, Suite 700, Fort Lauderdale, FL 33301\n\n" +
  "You received this because we believe it may be relevant to your business. Reply STOP or UNSUBSCRIBE to opt out and you won't hear from us again.";

const todayStr = (): string => new Date().toISOString().slice(0, 10);
const capUsed = (m: ColdMailboxRow): number => (m.sends_date === todayStr() ? m.sends_today : 0);

function safeDecrypt(packed: string | null): string {
  if (!packed) return "";
  try { return decryptField(packed); } catch { return ""; }
}

/** Active + warmup 'ready' + under today's cap, ordered least-recently-used first (rotation). */
export async function listReadyColdMailboxes(tenantId: string): Promise<ColdMailboxRow[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("cold_sending_mailboxes")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .eq("warmup_status", "ready")
    .order("last_send_at", { ascending: true, nullsFirst: true });
  if (error || !data) return [];
  return (data as ColdMailboxRow[]).filter((m) => capUsed(m) < (m.daily_cap || 30));
}

/** Least-recently-used ready mailbox with headroom, or null when the pool is exhausted/empty. */
export async function pickColdMailbox(tenantId: string): Promise<ColdMailboxRow | null> {
  const ready = await listReadyColdMailboxes(tenantId);
  return ready[0] || null;
}

export type ColdRoute =
  | { route: "cold"; mailbox: ColdMailboxRow }
  | { route: "blocked"; reason: "no_cold_infra" }
  | { route: "primary" };

/**
 * The isolation rule, in one place. COLD sends resolve to a cold-pool mailbox or
 * are BLOCKED — never the primary domain. WARM/transactional sends resolve to the
 * primary per-rep path (handled elsewhere).
 */
export async function resolveSendRoute(tenantId: string, sendClass: SendClass): Promise<ColdRoute> {
  if (sendClass !== "cold") return { route: "primary" };
  const mailbox = await pickColdMailbox(tenantId);
  if (!mailbox) return { route: "blocked", reason: "no_cold_infra" };
  return { route: "cold", mailbox };
}

export type ColdSendResult =
  | { ok: true; provider: "cold_apppassword"; from_address: string; mailbox_id: string; message_id: string }
  | {
      ok: false;
      reason: "no_cold_infra" | "suppressed" | "suppression_error" | "unsafe" | "send_failed" | "not_supported";
      error: string;
    };

async function bumpCap(m: ColdMailboxRow): Promise<void> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  await db
    .from("cold_sending_mailboxes")
    .update({ sends_today: capUsed(m) + 1, sends_date: todayStr(), last_send_at: now, updated_at: now })
    .eq("id", m.id);
}

/**
 * Send ONE cold/marketing email through the cold pool. Fail-closed at every gate:
 * no ready mailbox → blocked (never primary); suppressed → blocked; safety check
 * can't run or a lender name is present → blocked. Never touches sunbizfunding.com.
 */
export async function sendColdEmail(args: {
  tenantId: string;
  to: string;
  subject: string;
  body: string;
  /** Optional: attribute the send to a CRM lead (opens/clicks move its stage). */
  leadId?: string | null;
  /** Campaign label → agent_source 'cold:<campaign>' so the Metrics tab buckets it. */
  campaign?: string;
}): Promise<ColdSendResult> {
  const mb = await pickColdMailbox(args.tenantId);
  if (!mb) {
    return { ok: false, reason: "no_cold_infra", error: "no ready cold mailbox — cold send blocked (never falls back to the primary domain)" };
  }
  if (mb.provider !== "app_password") {
    return { ok: false, reason: "not_supported", error: `cold provider '${mb.provider}' not wired yet (app_password only for now)` };
  }

  // Opt-out gate — fail closed.
  const supp = await checkEmailSuppressed(args.tenantId, args.to);
  if (supp.suppressed) return { ok: false, reason: "suppressed", error: "recipient in email_suppressions" };
  if (supp.checkFailed) return { ok: false, reason: "suppression_error", error: "suppression lookup failed — send blocked" };

  // Merchant-facing safety: em-dash strip + never-mention-lenders. Fail closed.
  const safe = await sanitizeBlastMessage(args.tenantId, args.body);
  if (!safe.ok) return { ok: false, reason: "unsafe", error: safe.message };

  const appPassword = safeDecrypt(mb.app_password_enc).replace(/\s+/g, "");
  if (!appPassword) return { ok: false, reason: "send_failed", error: "mailbox credential missing or undecryptable" };

  // send_id pins the lead_interactions row id so /api/track/open|click/<send_id>
  // attribute this cold send's opens/clicks (source 'cold:*' in the Metrics tab).
  const sendId = randomUUID();
  const textBody = safe.cleaned.replace(/\s+$/, "") + COLD_FOOTER;
  // COLD_FOOTER already carries the CAN-SPAM postal address + reply-based opt-out,
  // so the tracked HTML doesn't add a second (link) footer (unsub:'none'); the
  // one-click List-Unsubscribe header below is the link-based opt-out.
  const html = buildTrackedHtml(textBody, { sendId, email: args.to, brand: "SunBiz", unsub: "none" });

  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true,
      auth: { user: mb.address, pass: appPassword },
    });
    const info = await transporter.sendMail({
      from: mb.address,
      to: args.to,
      subject: args.subject,
      text: textBody,
      html,
      headers: {
        // RFC 8058 one-click (HTTPS) + a cold-domain mailto fallback (keeps
        // reputation isolation — no sunbizfunding.com reference in a cold send).
        "List-Unsubscribe": `<${unsubscribeApiUrl(args.to, "SunBiz")}>, <mailto:unsubscribe@${mb.domain}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    await bumpCap(mb);
    // Best-effort attribution log — never fail the send on a logging error.
    try {
      const db = getServiceSupabase();
      await db.from("lead_interactions").insert({
        id: sendId,
        tenant_id: args.tenantId,
        lead_id: args.leadId || null,
        type: "email_sent",
        channel: "email",
        direction: "outbound",
        agent_source: `cold:${(args.campaign || "blast").slice(0, 60)}`,
        to_email: args.to,
        subject: args.subject,
        content_preview: textBody.slice(0, 1024),
        provider: "cold_apppassword",
        provider_message_id: info.messageId || null,
        metadata: { provider: "cold_apppassword", mailbox_id: mb.id, dry_run: false, cold: true },
      });
    } catch (logErr) {
      console.error("[cold-sending] interaction log failed", logErr);
    }
    return { ok: true, provider: "cold_apppassword", from_address: mb.address, mailbox_id: mb.id, message_id: info.messageId || "" };
  } catch (e) {
    return { ok: false, reason: "send_failed", error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "smtp_error" };
  }
}

/** Register (or update) a cold mailbox. App password stored encrypted; never returned. */
export async function registerColdMailbox(args: {
  tenantId: string;
  domain: string;
  address: string;
  appPassword: string;
  dailyCap?: number;
  warmupStatus?: "warming" | "ready" | "paused";
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("cold_sending_mailboxes")
    .upsert(
      {
        tenant_id: args.tenantId,
        domain: args.domain.trim().toLowerCase(),
        address: args.address.trim(),
        provider: "app_password",
        app_password_enc: encryptField(args.appPassword),
        daily_cap: args.dailyCap ?? 30,
        warmup_status: args.warmupStatus || "warming",
        active: true,
        updated_at: now,
      },
      { onConflict: "tenant_id,address" },
    )
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

export type ColdMailboxPublic = {
  id: string; domain: string; address: string; provider: string;
  daily_cap: number; sends_today: number; sends_date: string | null;
  last_send_at: string | null; warmup_status: string; active: boolean;
};

/** List cold mailboxes for a tenant WITHOUT secrets (for the management UI). */
export async function listColdMailboxes(tenantId: string): Promise<ColdMailboxPublic[]> {
  const db = getServiceSupabase();
  const { data } = await db
    .from("cold_sending_mailboxes")
    .select("id, domain, address, provider, daily_cap, sends_today, sends_date, last_send_at, warmup_status, active")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  return (data as ColdMailboxPublic[]) || [];
}
