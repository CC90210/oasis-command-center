/**
 * Scan the submissions@ inbox for BOUNCE-BACKS (delivery-status notifications)
 * from the SunBiz email drip, extract the failed recipient + hard/soft class,
 * and (write mode) add hard-bounced merchant addresses to `email_suppressions`
 * so the live drip stops emailing dead mailboxes.
 *
 * This is the deliberate INVERSE of scan-lender-replies: that cron reads the
 * same submissions@ inbox and SKIPS `mailer-daemon|postmaster|no-reply`
 * (line ~172). Those skipped messages ARE the bounces. This cron captures them.
 *
 * DRY-RUN by default — returns classified results, writes NOTHING. ?write=1 applies.
 *
 * Auth: checkCronAuth (SCAN_TRIGGER_SECRET / CRON_SECRET bearer, constant-time,
 * fail-closed). Reads submissions@ over IMAP using the tenant's encrypted gws
 * app-password (getSubmissionsCreds). Read-only: never marks messages \Seen, so
 * it cannot hide a lender reply from scan-lender-replies. Idempotent: the
 * suppression upsert keys on (email,tenant_id,brand) — reprocessing a bounce is
 * a no-op.
 *
 * SAFETY: only HARD bounces (5.x.x / SMTP 5xx) are suppressed, and only when the
 * failed recipient is NOT a known lender contact — suppressing a lender address
 * would poison shop-out deliverability. Soft bounces (4.x.x) are reported, never
 * suppressed. An address we cannot confidently parse is left alone (fail-safe:
 * we would rather miss a suppression than wrongly block a real merchant).
 *
 * WATCHDOG (silent-failure guard): fires a Telegram alert on (a) any fail-closed
 * path — creds error, IMAP connect error, lender-list load error, suppression
 * write error — so a bounce reader that quietly stops is never silent; and (b) a
 * bounce SPIKE — when a run NEWLY suppresses >= BOUNCE_SPIKE_ALERT (default 5)
 * addresses, so a degrading list / burning domain gets eyes fast. The spike gate
 * is on NEWLY-suppressed only, so the 3-day lookback can't re-alert every tick.
 * All alerts soft-fail (sendTelegram never throws).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ImapFlow } from "imapflow";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getSubmissionsCreds } from "@/lib/integrations/submissions-gmail";
import { sendTelegram, escapeTelegramHtml } from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUNBIZ_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

type BounceClass = "hard" | "soft" | "unknown";

/** Normalize a parsed address: strip trailing punctuation/brackets, lowercase. */
function cleanAddr(a: string): string {
  return String(a || "").trim().replace(/^[<]+|[>.,;:]+$/g, "").toLowerCase();
}

/**
 * Pull the failed recipient out of a bounce. Prefers the RFC 3464 machine
 * fields (Final-Recipient / Original-Recipient / X-Failed-Recipients); falls
 * back to a diagnostic/human-text address near a failure keyword.
 */
function extractFailedRecipient(raw: string): string | null {
  let m = raw.match(/^(?:Final-Recipient|Original-Recipient):\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+?)>?\s*$/im);
  if (m) return cleanAddr(m[1]);
  m = raw.match(/^X-Failed-Recipients:\s*<?([^\s<>,;]+@[^\s<>,;]+)/im);
  if (m) return cleanAddr(m[1]);
  m = raw.match(/(?:failed|not found|unknown|rejected|undeliverable)[^@\n]{0,80}?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/i);
  if (m) return cleanAddr(m[1]);
  return null;
}

/**
 * Classify the bounce. RFC 3464 `Status:` (5.x.x hard / 4.x.x soft / 2.x.x ok)
 * first, then the SMTP `Diagnostic-Code`, then human-text heuristics for MTAs
 * that omit the machine fields.
 */
function bounceClass(raw: string): BounceClass {
  const st = raw.match(/^Status:\s*([245])\.\d+\.\d+/im);
  if (st) {
    if (st[1] === "5") return "hard";
    if (st[1] === "4") return "soft";
    if (st[1] === "2") return "unknown"; // delivered (delay report) — not a failure
  }
  const dc = raw.match(/Diagnostic-Code:\s*smtp;\s*(\d{3})/im);
  if (dc) {
    const code = Number(dc[1]);
    if (code >= 500 && code < 600) return "hard";
    if (code >= 400 && code < 500) return "soft";
  }
  if (/\b(550|551|553|554)\b|user unknown|no such user|does ?n[o']t exist|mailbox (?:not found|unavailable|does not exist)|address (?:not found|rejected)|recipient (?:rejected|not found)|account (?:has been )?disabled/i.test(raw)) return "hard";
  if (/\b(421|450|451|452)\b|temporar|over quota|mailbox full|quota exceeded|try again later|deferred|greylist/i.test(raw)) return "soft";
  return "unknown";
}

/**
 * Best-effort original Message-ID for future drip_runs.provider_message_id
 * correlation. The DSN's own Message-ID sits in the top headers; the original
 * is inside the attached message/rfc822 part further down, so take the LAST
 * occurrence. Reported only — not yet written (correlation validated in dry-run
 * before we wire the drip_runs write).
 */
function originalMessageId(raw: string): string | null {
  const ids = [...raw.matchAll(/^Message-ID:\s*<([^>\r\n]+)>/gim)].map((x) => x[1]);
  return ids.length ? ids[ids.length - 1] : null;
}

/** Watchdog alert — soft-fail wrapper so a bad token never affects the run. */
async function watchdogAlert(text: string): Promise<void> {
  try { await sendTelegram(text); } catch { /* sendTelegram already soft-fails; belt-and-suspenders */ }
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const write = url.searchParams.get("write") === "1";
  const lookbackDays = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 3));
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 40));
  const db = getServiceSupabase();

  let creds: { fromAddress: string; appPassword: string };
  try {
    creds = await getSubmissionsCreds(SUNBIZ_TENANT_ID);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    await watchdogAlert(`🔴 <b>Bounce reader DOWN</b> — submissions@ credentials error: ${escapeTelegramHtml(msg)}. Bounce suppression is NOT running until fixed.`);
    return NextResponse.json({ ok: false, error: "creds_" + msg, error_class: "creds" }, { status: 500 });
  }

  // Known lender contact addresses — NEVER suppress these (would break shop-out).
  const lenderEmails = new Set<string>();
  try {
    const lendersR = await db.from("tenant_records").select("data").eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "lender");
    for (const r of (lendersR.data || []) as { data: Record<string, unknown> }[]) {
      const c = String(r.data?.contact || "").toLowerCase().trim();
      if (c.includes("@")) lenderEmails.add(c);
    }
  } catch {
    // If we can't load lenders, fail closed on suppression: better to suppress
    // nothing this run than risk poisoning a lender contact.
    await watchdogAlert(`🔴 <b>Bounce reader DOWN</b> — could not load the lender exclusion list (DB error). Skipped this run to avoid poisoning a lender contact.`);
    return NextResponse.json({ ok: false, error: "lender_load_failed", error_class: "db" }, { status: 500 });
  }

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: creds.fromAddress, pass: creds.appPassword.replace(/\s+/g, "") },
    logger: false,
    greetingTimeout: 12_000, socketTimeout: 25_000,
  });

  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    await watchdogAlert(`🔴 <b>Bounce reader DOWN</b> — IMAP connect to submissions@ failed: ${escapeTelegramHtml(msg)}. Bounce suppression is NOT running until fixed.`);
    return NextResponse.json({ ok: false, error: "imap_connect_" + msg, error_class: "imap" }, { status: 502 });
  }

  const results: Array<Record<string, unknown>> = [];
  const toSuppress = new Set<string>();
  let scanned = 0;

  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
    // Target bounce senders/subjects. IMAP's OR is binary, and imapflow's N-term
    // `or` proved unreliable at runtime (the deployed cron found 0 bounces while a
    // Python imaplib test with the SAME criteria found them). So run each criterion
    // as its own search and union the UIDs — robust + matches the verified dry-run.
    const criteria: Array<{ from?: string; subject?: string }> = [
      { from: "mailer-daemon" },
      { from: "postmaster" },
      { subject: "Delivery Status Notification" },
      { subject: "Undeliverable" },
      { subject: "failure notice" },
      { subject: "returned mail" },
      { subject: "Mail delivery failed" },
      { subject: "Delivery has failed" },
    ];
    const seen = new Set<number>();
    const uids: number[] = [];
    for (const crit of criteria) {
      const found = (await client.search({ since, ...crit })) || [];
      for (const u of (Array.isArray(found) ? found : [])) {
        if (!seen.has(u)) { seen.add(u); uids.push(u); }
      }
    }
    const recent = uids.slice(-limit);

    for await (const msg of client.fetch(recent, { envelope: true, source: true })) {
      scanned++;
      const from = (msg.envelope?.from?.[0]?.address || "").toLowerCase();
      const subject = msg.envelope?.subject || "";
      const raw = (msg.source as Buffer)?.toString("utf8") || "";

      const recipient = extractFailedRecipient(raw);
      const klass = bounceClass(raw);
      const messageId = originalMessageId(raw);

      let action: string;
      if (!recipient) {
        action = "unparsed";
      } else if (lenderEmails.has(recipient)) {
        action = "skipped_lender";
      } else if (recipient.endsWith("@sunbizfunding.com")) {
        action = "skipped_own_domain";
      } else if (klass === "hard") {
        action = "suppress";
        toSuppress.add(recipient);
      } else if (klass === "soft") {
        action = "soft_noted";
      } else {
        action = "unknown_class";
      }

      results.push({ from, subject: subject.slice(0, 160), recipient, class: klass, action, original_message_id: messageId });
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
  }

  // ── Write (gated): upsert hard-bounced merchant addresses to suppression ─────
  let suppressed = 0;
  let newlySuppressed = 0;
  if (write && toSuppress.size > 0) {
    const emails = [...toSuppress];
    // Which are already suppressed? Needed so the spike alert fires on NEW volume
    // only — otherwise the 3-day lookback re-counts the same bounces every tick.
    const existing = await db.from("email_suppressions").select("email").eq("tenant_id", SUNBIZ_TENANT_ID).in("email", emails);
    const already = new Set(((existing.data || []) as { email: string }[]).map((r) => String(r.email).toLowerCase()));
    newlySuppressed = emails.filter((e) => !already.has(e)).length;

    const rows = emails.map((email) => ({
      tenant_id: SUNBIZ_TENANT_ID,
      email,
      brand: null as string | null,
      reason: "hard_bounce",
      source: "bounce_reader",
    }));
    const up = await db.from("email_suppressions").upsert(rows, { onConflict: "email,tenant_id,brand" });
    if (up.error) {
      await watchdogAlert(`🔴 <b>Bounce reader</b> — suppression write FAILED: ${escapeTelegramHtml(up.error.message)}. ${toSuppress.size} bounced addresses were NOT suppressed; the drip may keep hitting them.`);
      return NextResponse.json({ ok: false, error: "suppress_write:" + up.error.message, error_class: "db", scanned, results }, { status: 500 });
    }
    suppressed = rows.length;
  }

  // ── Watchdog: bounce-spike alert (NEW suppressions only, write mode only) ─────
  const SPIKE = Number(process.env.BOUNCE_SPIKE_ALERT) || 5;
  if (write && newlySuppressed >= SPIKE) {
    const sample = [...toSuppress].slice(0, 8).map((e) => escapeTelegramHtml(e)).join(", ");
    await watchdogAlert(
      `⚠️ <b>Bounce spike</b> — ${newlySuppressed} NEW hard bounces suppressed from submissions@ this run ` +
      `(threshold ${SPIKE}). Sample: ${sample}. Check drip list hygiene / sending volume before reputation drops.`,
    );
  }

  const hard = results.filter((r) => r.class === "hard").length;
  const soft = results.filter((r) => r.class === "soft").length;
  const unparsed = results.filter((r) => r.action === "unparsed").length;

  return NextResponse.json({
    ok: true,
    mode: write ? "write" : "dry",
    inbox: creds.fromAddress,
    scanned,
    hard,
    soft,
    unparsed,
    lender_skipped: results.filter((r) => r.action === "skipped_lender").length,
    to_suppress: toSuppress.size,
    suppressed,
    newly_suppressed: newlySuppressed,
    spike_threshold: SPIKE,
    results,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
