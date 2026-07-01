/**
 * Scan the submissions@ inbox for lender replies to shopped deals, classify
 * approval/decline + extract offer terms + the structured decline reason, and
 * (write mode) update the lender thread status, populate the deal's Offers tab,
 * AND append to the lender-intelligence outcome ledger (lender_reply_outcomes).
 *
 * DRY-RUN by default — returns classified results, writes NOTHING. ?write=1 applies.
 *
 * Auth: SCAN_TRIGGER_SECRET bearer (constant-time, fail-closed). Reads submissions@
 * over IMAP using the tenant's encrypted gws app-password.
 *
 * PERFORMANCE (2026-06-30 — fixed the 504): the prior version classified each
 * email SEQUENTIALLY via an LLM call inside the IMAP loop, so a batch of replies
 * exceeded maxDuration=60 → 504. Now: bounded batch, the IMAP fetch/parse pass is
 * separated from classification, IMAP logs out BEFORE classifying, classification
 * runs in a small concurrency POOL, and the LLM fetch has its own timeout.
 *
 * SECURITY: lender bodies are untrusted — classify-reply fences them + schema-
 * validates; fail-closed (an unclassifiable reply lands as `responded`, never
 * auto-decided).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getSubmissionsCreds } from "@/lib/integrations/submissions-gmail";
import { classifyLenderReply, type LenderReplyCategory, type LenderReplyClass } from "@/lib/lenders/classify-reply";
import { timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUNBIZ_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const CLASSIFY_CONCURRENCY = 4;

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
function statusFor(cat: LenderReplyCategory): string {
  if (cat === "approved") return "approved";
  if (cat === "declined") return "declined";
  if (cat === "counter_offer" || cat === "info_needed") return "info_requested";
  return "responded";
}
// Out-of-office / auto-reply detection so we don't waste a classify call (and
// don't mis-status a thread) on a vacation bounce.
function isAutoReply(subject: string, headerLines: string): boolean {
  const s = String(subject || "").toLowerCase();
  if (/auto-submitted:\s*auto-(replied|generated)/i.test(headerLines)) return true;
  if (/x-autoreply|x-autorespond|precedence:\s*(auto_reply|bulk)/i.test(headerLines)) return true;
  return /out of office|out-of-office|auto-?reply|automatic reply|on vacation|away from (the|my) office|will be out|currently away/i.test(s);
}

// Bounded-concurrency map so N classify calls run ~CLASSIFY_CONCURRENCY at a time.
async function mapPool<T, R>(items: T[], cap: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, worker));
  return out;
}

function checkTrigger(req: NextRequest): NextResponse | null {
  const secret = process.env.SCAN_TRIGGER_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "trigger_not_configured" }, { status: 500 });
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

type Thread = { id: string; application_id: string; lender_id: string | null; status: string; subject: string | null; sent_at: string | null; last_response_at: string | null };

export async function GET(req: NextRequest) {
  const denied = checkTrigger(req);
  if (denied) return denied;

  const url = new URL(req.url);
  if (url.searchParams.get("probe") === "1") {
    const probe = await classifyLenderReply(
      "Re: New Deal (Probe Co)",
      "Hi team, we're pleased to approve Probe Co for $50,000.00 at a 1.35 factor rate over a 6 month term. Please send the contract.",
    );
    return NextResponse.json({ ok: true, probe });
  }
  const write = url.searchParams.get("write") === "1";
  const lookbackDays = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 5));
  // Bounded per-invocation batch — the /8-min trigger + per-thread cursor keep up
  // with reply volume without ever blowing maxDuration.
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
  const db = getServiceSupabase();

  let creds: { fromAddress: string; appPassword: string };
  try {
    creds = await getSubmissionsCreds(SUNBIZ_TENANT_ID);
  } catch (e) {
    return NextResponse.json({ ok: false, error: "creds_" + (e instanceof Error ? e.message : "unknown"), error_class: "creds" }, { status: 500 });
  }

  const [threadsR, appsR, lendersR] = await Promise.all([
    db.from("application_lender_threads").select("id, application_id, lender_id, status, subject, sent_at, last_response_at").eq("tenant_id", SUNBIZ_TENANT_ID),
    db.from("tenant_records").select("id, data").eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "application"),
    db.from("tenant_records").select("id, data").eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "lender"),
  ]);
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

  // ── Phase 1: IMAP fetch + parse + match (FAST — no LLM) ──────────────────────
  type Candidate = {
    subject: string; from: string; date: Date | null; bizName: string;
    appId: string; lenderId: string | null; lenderName: string | null;
    thread: Thread | null; body: string; already: boolean;
  };
  const candidates: Candidate[] = [];
  const results: Array<Record<string, unknown>> = [];

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: creds.fromAddress, pass: creds.appPassword.replace(/\s+/g, "") },
    logger: false,
    // Bound IMAP so a hung connection can't ride out the whole maxDuration.
    greetingTimeout: 12_000, socketTimeout: 25_000,
  });

  try {
    await client.connect();
  } catch (e) {
    return NextResponse.json({ ok: false, error: "imap_connect_" + (e instanceof Error ? e.message : "unknown"), error_class: "imap" }, { status: 502 });
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
      if (!bizName) continue;

      const fromLc = from.toLowerCase();
      const sdom = domainOf(from);
      if (!from || sdom === "sunbizfunding.com" || /mailer-daemon|postmaster|no-?reply/.test(fromLc)) continue;

      let body = "";
      let headerLines = "";
      try {
        const parsed = await simpleParser(msg.source as Buffer);
        body = (parsed.text || parsed.html || "").toString();
        headerLines = parsed.headerLines?.map((h: { key: string; line: string }) => `${h.key}: ${h.line}`).join("\n") || "";
      } catch {
        body = "";
      }
      if (isAutoReply(subject, headerLines)) {
        results.push({ subject, from, bizName, match: "auto_reply_skipped" });
        continue;
      }

      const bn = bizName.toLowerCase();
      const app = apps.find((a) => a.name === bn || a.name.includes(bn) || bn.includes(a.name));
      if (!app) {
        results.push({ subject, from, bizName, match: "no_application" });
        continue;
      }
      const lender = lenders.find((l) => l.email && (l.email === fromLc || (l.domain && sdom && l.domain === sdom))) || null;
      const appThreads = threads.filter((t) => t.application_id === app.id);
      const thread = (lender ? appThreads.find((t) => t.lender_id === lender.id) : null) || (appThreads.length === 1 ? appThreads[0] : null);

      const cursor = thread?.last_response_at ? Date.parse(thread.last_response_at) : 0;
      const already = !!(date && cursor && date.getTime() <= cursor);

      candidates.push({
        subject, from, date, bizName,
        appId: app.id, lenderId: lender?.id || null, lenderName: lender?.name || null,
        thread, body, already,
      });
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
  }

  // ── Phase 2: classify the NOT-already candidates in a bounded pool ───────────
  const toClassify = candidates.filter((c) => !c.already);
  const classes = await mapPool(toClassify, CLASSIFY_CONCURRENCY, (c) => classifyLenderReply(c.subject, c.body));
  const classBy = new Map<Candidate, LenderReplyClass>();
  toClassify.forEach((c, i) => classBy.set(c, classes[i]));

  // Dead-inference-key signature: a non-trivial batch where EVERYTHING came back
  // "unknown" almost always means the classifier key is dead/rate-limited (every
  // reply silently falls back to "unknown" and nothing gets written). Surface it.
  const unknownCount = classes.filter((c) => c.category === "unknown").length;
  const deadKeySuspected = toClassify.length >= 5 && unknownCount === toClassify.length;

  // ── Phase 3: writes (gated) ─────────────────────────────────────────────────
  let applied = 0;
  for (const c of candidates) {
    const cls = classBy.get(c);
    const row: Record<string, unknown> = {
      subject: c.subject, from: c.from, bizName: c.bizName,
      application_id: c.appId, lender: c.lenderName, lender_id: c.lenderId,
      thread_id: c.thread?.id || null, date: c.date ? c.date.toISOString() : null,
      already: c.already, classification: cls || null,
    };

    if (write && cls && !c.already && cls.category !== "unknown") {
      const replyAt = c.date ? c.date.toISOString() : new Date().toISOString();
      const summary = `${cls.category}${cls.amount ? ` $${cls.amount}` : ""}${cls.term_months ? ` / ${cls.term_months}mo` : ""}${cls.factor_rate ? ` / ${cls.factor_rate}` : ""}${cls.decline_reason_code ? ` · ${cls.decline_reason_code}` : ""}`.slice(0, 480);

      // 1) thread status (drives the pill) — only when a thread row exists.
      if (c.thread) {
        const upd = await db.from("application_lender_threads")
          .update({ status: statusFor(cls.category), last_response_at: replyAt, last_response_summary: summary, updated_at: new Date().toISOString() })
          .eq("id", c.thread.id).eq("tenant_id", SUNBIZ_TENANT_ID);
        if (!upd.error) { applied++; row.wrote = statusFor(cls.category); }
      }

      // 2) offer record (Offers tab) — approval/counter with usable terms + a lender.
      if ((cls.category === "approved" || cls.category === "counter_offer") && (cls.amount || cls.term_months || cls.factor_rate) && c.lenderId) {
        const existing = await db.from("tenant_records").select("id, data")
          .eq("tenant_id", SUNBIZ_TENANT_ID).eq("entity_type", "offer")
          .eq("data->>application_id", c.appId).eq("data->>lender_id", c.lenderId).limit(1);
        const offerData = {
          business_name: c.bizName, application_id: c.appId, lender_id: c.lenderId, lender_name: c.lenderName,
          amount: cls.amount ?? undefined, term_months: cls.term_months ?? undefined, factor_rate: cls.factor_rate ?? undefined,
          stage: "approved", source: "lender_reply_scan",
        };
        const existRow = existing.data?.[0] as { id: string; data: Record<string, unknown> } | undefined;
        if (existRow) {
          await db.from("tenant_records").update({ data: { ...existRow.data, ...offerData }, updated_at: new Date().toISOString() }).eq("id", existRow.id).eq("tenant_id", SUNBIZ_TENANT_ID);
        } else {
          await db.from("tenant_records").insert({ tenant_id: SUNBIZ_TENANT_ID, entity_type: "offer", data: offerData });
        }
        row.offer = `${cls.amount ?? "-"}/${cls.term_months ?? "-"}mo/${cls.factor_rate ?? "-"}`;
        if (!c.thread) applied++;
      }

      // 3) lender-intelligence ledger — every matched-lender outcome, with the
      // structured reason. Idempotent on (tenant, app, lender, reply_at).
      if (c.lenderId) {
        await db.from("lender_reply_outcomes").upsert({
          tenant_id: SUNBIZ_TENANT_ID,
          application_id: c.appId,
          lender_id: c.lenderId,
          outcome: cls.category,
          decline_reason_code: cls.decline_reason_code,
          decline_reason_detail: cls.decline_reason_detail,
          offer_amount: cls.amount,
          offer_term_months: cls.term_months,
          offer_factor: cls.factor_rate,
          conditions: cls.conditions,
          confidence: cls.confidence,
          reply_at: replyAt,
        }, { onConflict: "tenant_id,application_id,lender_id,reply_at" });
        row.outcome_logged = true;
      }
    }

    results.push(row);
  }

  return NextResponse.json({ ok: true, mode: write ? "write" : "dry", inbox: creds.fromAddress, scanned: results.length, classified: toClassify.length, unknown: unknownCount, dead_key_suspected: deadKeySuspected, applied, results });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
