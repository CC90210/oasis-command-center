/**
 * Vercel cron handler: scan the submissions@ inbox for lender replies to shopped
 * deals, classify approval/decline + extract offer terms, and (write mode) update
 * the lender thread status + populate the deal's Offers tab.
 *
 * DRY-RUN by default — returns the matched/classified results as JSON and writes
 * NOTHING. Pass ?write=1 to apply (thread status + offer upsert). Writes are held
 * off the cron schedule until the dry-run is verified + Bravo confirms the
 * contract.
 *
 * Auth: CRON_SECRET (checkCronAuth). Reads submissions@ over IMAP using the
 * tenant's encrypted gws app-password (getSubmissionsCreds) — the same credential
 * the app sends shop-outs with; no master secret leaves Vercel.
 *
 * SECURITY: lender email bodies are untrusted — classify-reply fences them and
 * schema-validates the extracted terms; this route fail-closes (a reply we can't
 * confidently classify lands as `responded` for human review, never auto-decided).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getSubmissionsCreds } from "@/lib/integrations/submissions-gmail";
import { classifyLenderReply, type LenderReplyCategory } from "@/lib/lenders/classify-reply";
import { checkCronAuth } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUNBIZ_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

function extractBusinessName(subject: string): string {
  const s = String(subject || "");
  const m = s.match(/New Deal\s*\(([^)]+)\)/i) || s.match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : "";
}
function domainOf(addr: string): string {
  const a = String(addr || "").toLowerCase();
  const i = a.indexOf("@");
  return i >= 0 ? a.slice(i + 1) : "";
}
// classification → thread status. Fail-closed: anything not a clear yes/no lands
// as `responded` (human review), never silently approved/declined.
function statusFor(cat: LenderReplyCategory): string {
  if (cat === "approved") return "approved";
  if (cat === "declined") return "declined";
  if (cat === "counter_offer" || cat === "info_needed") return "info_requested";
  return "responded";
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const write = url.searchParams.get("write") === "1";
  const lookbackDays = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 5));
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const db = getServiceSupabase();

  let creds: { fromAddress: string; appPassword: string };
  try {
    creds = await getSubmissionsCreds(SUNBIZ_TENANT_ID);
  } catch (e) {
    return NextResponse.json({ ok: false, error: "creds_" + (e instanceof Error ? e.message : "unknown") }, { status: 500 });
  }

  // Preload threads + applications + lenders for matching.
  const [threadsR, appsR, lendersR] = await Promise.all([
    db.from("application_lender_threads").select("id, application_id, lender_id, status, subject, sent_at, last_response_at").eq("tenant_id", SUNBIZ_TENANT_ID),
    db.from("tenant_records").select("id, data").eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "application"),
    db.from("tenant_records").select("id, data").eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "lender"),
  ]);
  type Thread = { id: string; application_id: string; lender_id: string | null; status: string; subject: string | null; sent_at: string | null; last_response_at: string | null };
  const threads = (threadsR.data || []) as Thread[];
  const apps = (appsR.data || []).map((r) => {
    const d = (r as { id: string; data: Record<string, unknown> }).data || {};
    return { id: (r as { id: string }).id, name: String(d.business_legal_name || d.business_name || d.company || "").trim().toLowerCase() };
  }).filter((a) => a.name);
  const lenders = (lendersR.data || []).map((r) => {
    const d = (r as { id: string; data: Record<string, unknown> }).data || {};
    const email = String(d.contact || "").toLowerCase();
    return { id: (r as { id: string }).id, name: String(d.name || ""), email: email.includes("@") ? email : "", domain: email.includes("@") ? domainOf(email) : "" };
  });

  const results: Array<Record<string, unknown>> = [];
  let applied = 0;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.fromAddress, pass: creds.appPassword.replace(/\s+/g, "") },
    logger: false,
  });

  try {
    await client.connect();
  } catch (e) {
    return NextResponse.json({ ok: false, error: "imap_connect_" + (e instanceof Error ? e.message : "unknown") }, { status: 502 });
  }

  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
    const uids = (await client.search({ since })) || [];
    const recent = (Array.isArray(uids) ? uids : []).slice(-limit);

    for await (const msg of client.fetch(recent, { envelope: true, source: true })) {
      const subject = msg.envelope?.subject || "";
      const from = msg.envelope?.from?.[0]?.address || "";
      const date = msg.envelope?.date instanceof Date ? msg.envelope.date : null;
      const bizName = extractBusinessName(subject);
      if (!bizName) continue; // not a deal reply

      const bn = bizName.toLowerCase();
      const app = apps.find((a) => a.name === bn || a.name.includes(bn) || bn.includes(a.name));
      if (!app) {
        results.push({ subject, from, bizName, match: "no_application" });
        continue;
      }
      const fromLc = from.toLowerCase();
      const sdom = domainOf(from);
      const lender = lenders.find((l) => l.email && (l.email === fromLc || (l.domain && sdom && l.domain === sdom))) || null;
      const appThreads = threads.filter((t) => t.application_id === app.id);
      const thread = (lender ? appThreads.find((t) => t.lender_id === lender.id) : null) || (appThreads.length === 1 ? appThreads[0] : null);

      const cursor = thread?.last_response_at ? Date.parse(thread.last_response_at) : 0;
      const already = !!(date && cursor && date.getTime() <= cursor);

      let body = "";
      try {
        const parsed = await simpleParser(msg.source as Buffer);
        body = (parsed.text || parsed.html || "").toString();
      } catch {
        body = "";
      }
      const cls = await classifyLenderReply(subject, body);

      const row: Record<string, unknown> = {
        subject, from, bizName,
        application_id: app.id,
        lender: lender?.name || null,
        lender_id: lender?.id || null,
        thread_id: thread?.id || null,
        date: date ? date.toISOString() : null,
        already,
        classification: cls,
      };

      // ---- write side (gated) ----
      if (write && thread && !already && cls.category !== "unknown") {
        const newStatus = statusFor(cls.category);
        const summary = `${cls.category}${cls.amount ? ` $${cls.amount}` : ""}${cls.term_months ? ` / ${cls.term_months}mo` : ""}${cls.factor_rate ? ` / ${cls.factor_rate}` : ""}`.slice(0, 480);
        const upd = await db.from("application_lender_threads")
          .update({ status: newStatus, last_response_at: date ? date.toISOString() : new Date().toISOString(), last_response_summary: summary, updated_at: new Date().toISOString() })
          .eq("id", thread.id).eq("tenant_id", SUNBIZ_TENANT_ID);
        if (!upd.error) applied++;

        // populate the Offers tab on an approval/counter with usable terms
        if ((cls.category === "approved" || cls.category === "counter_offer") && (cls.amount || cls.term_months || cls.factor_rate) && lender) {
          const existing = await db.from("tenant_records").select("id, data")
            .eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "offer")
            .eq("data->>application_id", app.id).eq("data->>lender_id", lender.id).limit(1);
          const offerData = {
            business_name: bizName,
            application_id: app.id,
            lender_id: lender.id,
            lender_name: lender.name,
            amount: cls.amount ?? undefined,
            term_months: cls.term_months ?? undefined,
            factor_rate: cls.factor_rate ?? undefined,
            stage: "approved",
            source: "lender_reply_scan",
          };
          const existRow = existing.data?.[0] as { id: string; data: Record<string, unknown> } | undefined;
          if (existRow) {
            await db.from("tenant_records").update({ data: { ...existRow.data, ...offerData }, updated_at: new Date().toISOString() }).eq("id", existRow.id).eq("tenant_id", SUNBIZ_TENANT_ID);
          } else {
            await db.from("tenant_records").insert({ tenant_id: SUNBIZ_TENANT_ID, entity_type: "offer", data: offerData });
          }
        }
        row.wrote = newStatus;
      }

      results.push(row);
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
  }

  return NextResponse.json({ ok: true, mode: write ? "write" : "dry", inbox: creds.fromAddress, scanned: results.length, applied, results });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
