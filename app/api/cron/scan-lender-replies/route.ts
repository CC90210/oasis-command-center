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
import { checkCronAuth } from "@/lib/cron-auth";
import { updateRecord } from "@/lib/manifest/data";
import { planApplicationRoute, minConfidenceFromEnv, autoRouteLive } from "@/lib/lenders/auto-route";
import { timingSafeEqual } from "crypto";

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

// Classify budget. maxDuration is 60s; Phase 1 (IMAP) and Phase 3 (writes) need
// the remainder, so classification gets a hard wall-clock slice and defers the
// rest to the next 8-minute tick.
const CLASSIFY_BUDGET_MS = Number(process.env.LENDER_SCAN_CLASSIFY_BUDGET_MS || 40_000);
/** Don't start a call that cannot plausibly finish. */
const MIN_CLASSIFY_MS = 8_000;
/** Ceiling for any single classify, so one wedged job can't eat the whole budget. */
const MAX_PER_CLASSIFY_MS = 22_000;

/**
 * EITHER auth is sufficient, and both are still constant-time and fail-closed.
 *
 * This route was manual-trigger only (SCAN_TRIGGER_SECRET bearer) and was
 * therefore never registered in vercel.json — which is why it had not written
 * anything since 2026-08-06 while 898 lender threads sat unread. Scheduling it
 * needs Vercel's own cron auth (checkCronAuth: CRON_SECRET bearer AND the
 * platform-injected `x-vercel-cron` header, neither forgeable alone).
 *
 * The existing manual path is kept working unchanged rather than migrated,
 * because it is the only way to run this on demand while diagnosing the inbox,
 * and taking it away would trade one outage for another.
 */
function checkTrigger(req: NextRequest): NextResponse | null {
  // TRY THE CRON GATE FIRST, and do NOT branch on the x-vercel-cron header to
  // decide whether to try it. The GitHub Actions driver is what actually fires
  // the crons in this repo (Vercel's own scheduler stopped on 2026-08-06), and
  // it sends the CRON_SECRET bearer with NO x-vercel-cron header — production
  // carries CRON_ALLOW_LOCAL=1 for exactly that path. Gating on the header
  // meant every scheduled call fell through to the SCAN_TRIGGER_SECRET
  // comparison, failed it, and 401'd: the scanner would have stayed exactly as
  // dead as it was, which is the one thing this change exists to fix (Codex
  // review P1, 2026-08-12).
  if (checkCronAuth(req) === null) return null;

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

  // Wall clock for the classify budget below. Phase 1 (IMAP) spends an unknown
  // slice of maxDuration, so the classify loop measures from here rather than
  // assuming a fixed allowance.
  const startedAt = Date.now();

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
    thread: Thread | null; body: string; already: boolean; appMatchUnambiguous: boolean;
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
      // Substring matching BOTH ways, first-match-wins. Deliberately loose, and
      // fine for what it was built for: updating a thread pill and filing an
      // offer, where a near-miss is a cosmetic error someone notices.
      //
      // It is NOT good enough to move a deal. "ABC" matches "ABC Holdings" and
      // vice versa, so with two similarly-named merchants a confident approval
      // could route the wrong file (Codex review P1, 2026-08-12). The routing
      // path therefore demands certainty, computed here and carried on the
      // candidate: an exact name, or a single candidate overall. Everything
      // else keeps the existing loose behaviour.
      const appMatches = apps.filter((a) => a.name === bn || a.name.includes(bn) || bn.includes(a.name));
      const exactMatches = appMatches.filter((a) => a.name === bn);
      const app = exactMatches[0] || appMatches[0];
      const appMatchUnambiguous = exactMatches.length === 1 || (exactMatches.length === 0 && appMatches.length === 1);
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
        thread, body, already, appMatchUnambiguous,
      });
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
  }

  // ── Phase 2: classify the NOT-already candidates, bounded by WALL CLOCK ──────
  //
  // Inference runs through the subscription queue (inference_jobs), which the
  // local CLI daemon drains SERIALLY on an 8s poll. A fixed-size concurrent
  // pool is therefore the wrong shape: N concurrent pollers still wait on one
  // serial executor, and a large batch would blow maxDuration=60 (the original
  // 504). Instead we classify sequentially for as long as the budget allows and
  // DEFER the rest — safe because an unclassified reply is simply not written,
  // so its thread cursor never advances and it is picked up next tick. The
  // 8-minute trigger drains any backlog over a few passes.
  //
  // OLDEST FIRST — this ordering is load-bearing, not cosmetic. Phase 1 fetches
  // `uids.slice(-limit)`, i.e. only the NEWEST messages in the lookback window,
  // so anything we defer is only retried next tick if it is still inside that
  // newest-N slice. Deferring oldest-first would push the most at-risk replies
  // out of the window permanently once enough new mail arrived. By classifying
  // oldest-first, whatever gets deferred is always the NEWEST — which is
  // exactly what is guaranteed to still be in range next tick.
  const toClassify = candidates
    .filter((c) => !c.already)
    .sort((a, b) => (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0));
  const classBy = new Map<Candidate, LenderReplyClass>();
  const deferredSet = new Set<Candidate>();
  let unavailableCount = 0;
  let pendingCount = 0;

  for (const c of toClassify) {
    const remaining = CLASSIFY_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < MIN_CLASSIFY_MS) { deferredSet.add(c); continue; }
    const cls = await classifyLenderReply(c.subject, c.body, {
      timeoutMs: Math.min(remaining, MAX_PER_CLASSIFY_MS),
      tenantId: SUNBIZ_TENANT_ID,
    });
    classBy.set(c, cls);
    if (cls.unavailable) {
      // Either way we stop: another call would burn its full timeout for a
      // near-certain miss and risk maxDuration. But WHY matters. `retryable`
      // means the job is still queued and the next tick collects it via the
      // dedupe key — ordinary latency, no alarm. Otherwise inference is
      // genuinely broken and someone needs paging.
      if (cls.retryable) pendingCount++;
      else unavailableCount++;
      // THIS candidate is uncommitted too and will be retried, so it is
      // deferred like the rest. It is already in classBy, so the loop below
      // would skip it and undercount by one while leaving its row unmarked.
      deferredSet.add(c);
      for (const rest of toClassify) if (!classBy.has(rest)) deferredSet.add(rest);
      break;
    }
  }

  // Only genuinely-classified replies count. A pending/unavailable result is an
  // absence of classification, not an "unknown" verdict about the lender, and
  // counting it as one would re-create the exact ambiguity this change removes.
  const classified = [...classBy.values()].filter((c) => !c.unavailable);
  const unknownCount = classified.filter((c) => c.category === "unknown").length;

  // The classifier being DOWN is now directly observable rather than inferred:
  // `unavailable` means inference itself failed, which no amount of lender
  // wording can fake. This is the signal that was missing when the paid API ran
  // dry on 2026-07-21 and a total outage looked like chatty lenders.
  const classifierDown = unavailableCount > 0;

  // Secondary signal for the other failure shape: inference RUNS but returns
  // garbage every time. Floor lowered from 5 to 2 — the old threshold meant a
  // steady 3-reply backlog could never trip it, which is exactly what happened.
  const allUnknown = classified.length >= 2 && unknownCount === classified.length;

  // Kept under the original key so an un-updated trigger still alerts.
  const deadKeySuspected = classifierDown || allUnknown;

  // ── Phase 3: writes (gated) ─────────────────────────────────────────────────
  let applied = 0;
  // Routing counters, reported whether or not routing is armed. A scanner that
  // reads mail every 8 minutes and routes nothing forever is the silent-failure
  // shape this repo keeps being bitten by; these are what a health check reads.
  let routed = 0;
  let flagged = 0;
  let wouldRoute = 0;
  let routeDeferred = 0;
  for (const c of candidates) {
    const cls = classBy.get(c);
    const row: Record<string, unknown> = {
      subject: c.subject, from: c.from, bizName: c.bizName,
      application_id: c.appId, lender: c.lenderName, lender_id: c.lenderId,
      thread_id: c.thread?.id || null, date: c.date ? c.date.toISOString() : null,
      already: c.already, classification: cls || null,
      // Ran out of classify budget (or inference was down) — NOT a property of
      // this reply. It stays uncommitted and is retried on the next tick.
      deferred: deferredSet.has(c) || undefined,
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

    // 4) ROUTE THE DEAL — move the clear ones, flag the rest (Adon 2026-08-12)
    //
    // DELIBERATELY OUTSIDE the write block above, which excludes
    // `category === "unknown"`. An unknown is precisely a reply a human needs
    // to look at, and leaving it in that block meant the one category most in
    // need of "flag the rest" was the one category that got no flag at all —
    // silently reclassified every tick, forever (Codex review P2, 2026-08-12).
    //
    // `!cls.unavailable` is load-bearing. When inference times out or is down,
    // classify-reply returns a REAL object with category "unknown" and
    // unavailable:true — the shape of an answer without being one. Treating it
    // as an unclassifiable reply would flag the deal and advance the cursor,
    // permanently consuming a message that was never actually read, and the
    // outage would present as a pile of "needs review" instead of as an outage
    // (Codex review P1, 2026-08-12). Nothing here may touch a reply the
    // classifier never saw; it stays for the next tick.
    if (write && cls && !cls.unavailable && !c.already) {
      const replyAt = c.date ? c.date.toISOString() : new Date().toISOString();
      //
      // Everything above describes the LENDER's answer. This is the only step
      // that touches the DEAL. The rule (lib/lenders/auto-route.ts) is
      // deliberately asymmetric: one approval moves the file, one decline does
      // not, because a decline is a fact about that funder and not about the
      // deal.
      //
      // Re-reads the threads instead of reusing the Phase-1 snapshot: step 1
      // just wrote this reply's own thread status, and unanimity computed from
      // a stale read would miss the decline that completes the set.
      const routeThreads = await db
        .from("application_lender_threads")
        .select("status")
        .eq("tenant_id", SUNBIZ_TENANT_ID)
        .eq("application_id", c.appId);

      // The application's CURRENT status, so a reply arriving after the deal
      // closed cannot drag it backwards.
      const appNow = await db
        .from("tenant_records")
        .select("data")
        .eq("tenant_id", SUNBIZ_TENANT_ID)
        .eq("entity_type", "application")
        .eq("id", c.appId)
        .maybeSingle();

      if (routeThreads.error || appNow.error) {
        // Fail CLOSED: without the full picture we cannot tell a unanimous
        // decline from a partial view, and a wrong move here kills a live deal.
        row.route = `deferred: threads_unreadable`;
        routeDeferred++;
        // ...and REWIND, for the same reason the write paths below do. Step 1
        // has already advanced the cursor, so a transient read failure would
        // otherwise consume a valid approval permanently while reporting it as
        // deferred (Codex review P1, 2026-08-12).
        if (c.thread) {
          await db
            .from("application_lender_threads")
            .update({ last_response_at: c.thread.last_response_at })
            .eq("id", c.thread.id)
            .eq("tenant_id", SUNBIZ_TENANT_ID);
        }
      } else {
        // The status the decision is made against. Held so the write below can
        // compare-and-set on exactly this value and refuse if it moved.
        const statusAtDecision = (appNow.data?.data as Record<string, unknown> | undefined)?.status;
        const decision = planApplicationRoute({
          threads: (routeThreads.data || []) as Array<{ status: string }>,
          reply: { category: cls.category, confidence: cls.confidence },
          minConfidence: minConfidenceFromEnv(),
          // Provenance: this email matched one of THIS deal's lender threads.
          // Without it an inbound stranger replying "Re: New Deal (X)" could
          // move a live file, because an approval does not consult the thread
          // list.
          // The thread must belong to the lender this email came FROM. Phase 1
          // falls back to "the only thread on this deal" when the sender has
          // no thread of its own, which is fine for pill display but not for
          // routing: it would let lender B's approval move a deal shopped only
          // to lender A (Codex review P1, 2026-08-12).
          // Three independent facts, all required: the deal was identified
          // unambiguously, the sender is a known lender, and that lender's own
          // thread is on this deal. Any one missing and the reply gets a flag
          // rather than a decision.
          hasMatchedThread: Boolean(
            c.appMatchUnambiguous && c.thread && c.lenderId && c.thread.lender_id === c.lenderId,
          ),
          currentStatus: statusAtDecision,
        });

        if (!decision.move) {
          // FLAGGED, not silently skipped. The thread pill already changed
          // above; this makes the DEAL itself say a human needs to look, so a
          // reply that lands outside the clear cases cannot go unnoticed.
          row.route = `flagged: ${decision.reason}`;
          flagged++;
          // NO THREAD MEANS NO CURSOR, so a flag here would be re-stamped on
          // every tick for as long as the message stays in the lookback
          // window — up to `days` (default 5) of repeated writes and inflated
          // counters (Codex review P2, 2026-08-12).
          //
          // Such a reply can never be routed anyway: provenance requires the
          // sending lender's own thread. Reported instead, so it is visible
          // without being re-written. NOTE the repeated CLASSIFY for these is
          // pre-existing — `already` has always been driven by the thread
          // cursor — and closing that needs a message-level cursor this change
          // does not introduce.
          if (!c.thread) {
            row.route = `${String(row.route)} (no_thread_no_cursor)`;
            results.push(row);
            continue;
          }

          let flagStamped = false;
          try {
            await updateRecord({
              // GUARDED like the routing write, and for a subtler reason:
              // updateRecord re-reads and merges the WHOLE data document, so
              // an unguarded flag write silently rewrites every other field as
              // it found them — including a status an operator changed a
              // moment ago. A flag is a small patch with a full-document
              // blast radius (Codex review P1, 2026-08-12).
              //
              // Losing this precondition is the right outcome: the deal moved,
              // so the rewind below retries and the next tick re-decides
              // against the status that actually holds.
              ifMatch: {
                field: "status",
                value:
                  statusAtDecision === undefined || statusAtDecision === null
                    ? null
                    : String(statusAtDecision),
              },
              tenant_id: SUNBIZ_TENANT_ID,
              entity: "application",
              id: c.appId,
              patch: {
                lender_reply_needs_review: true,
                lender_reply_review_reason: decision.reason.slice(0, 200),
              },
            });
            flagStamped = true;
          } catch (e) {
            // NOT swallowed. The IMAP cursor has already moved past this
            // message, so a flag that fails here is a review request the deal
            // never receives and nothing ever retries. Reported as deferred so
            // it shows in the counters rather than being counted as a
            // successful flag (Codex review P2, 2026-08-12).
            row.route = `flag_failed: ${e instanceof Error ? e.message : "unknown"}`;
            flagged--;
            routeDeferred++;

            // REWIND THE CURSOR so this reply is retried. Step 1 above already
            // advanced last_response_at for every non-unknown category, so
            // without this the next tick sees `already` and the review request
            // is lost permanently — a reply that needs a human, invisible
            // forever (Codex review P1, 2026-08-12).
            //
            // Retrying is safe: the thread-status write, the offer upsert and
            // the outcome-ledger upsert are all idempotent, so re-processing
            // this message costs one classify and changes nothing else.
            if (c.thread) {
              await db
                .from("application_lender_threads")
                .update({ last_response_at: c.thread.last_response_at })
                .eq("id", c.thread.id)
                .eq("tenant_id", SUNBIZ_TENANT_ID);
            }
          }

          // ADVANCE THE CURSOR FOR `unknown`, which nothing else does.
          //
          // `already` is computed from the thread's last_response_at, and step
          // 1 — the only writer of that column — is skipped for unknown. So an
          // unclassifiable reply was re-fetched, re-classified and re-flagged
          // every ten minutes forever, burning inference on the same message
          // indefinitely (Codex review P2, 2026-08-12).
          //
          // The STATUS is deliberately left alone: an unknown is not a
          // `responded` verdict, and the pill must not claim one. Only the
          // cursor moves, which is what makes the reply idempotent.
          // Gated on the flag having actually landed. Advancing the cursor for
          // a reply whose review request failed to stamp would make it
          // `already` next tick and lose it for good — the same defect as the
          // rewind above, from the other direction.
          if (cls.category === "unknown" && c.thread && flagStamped) {
            const cur = await db
              .from("application_lender_threads")
              .update({
                last_response_at: replyAt,
                last_response_summary: "unclassifiable reply — flagged for review",
                updated_at: new Date().toISOString(),
              })
              .eq("id", c.thread.id)
              .eq("tenant_id", SUNBIZ_TENANT_ID);
            if (cur.error) {
              // Left retryable on purpose: without the cursor this repeats, so
              // the honest report is that it is not yet settled.
              row.route = `${String(row.route)} (cursor_not_advanced)`;
              routeDeferred++;
            }
          }
        } else if (!autoRouteLive()) {
          // Staged go-live: report what it WOULD have done so a day of real
          // replies can be read before anything moves.
          row.route = `would_route: ${decision.to} (${decision.reason})`;
          wouldRoute++;
        } else {
          // updateRecord, NOT a raw tenant_records write. It is what stamps
          // stage_entered_at, publishes BRAVO_RECORD_STATUS_CHANGED and fires
          // runStageTransitionHooks. A raw write would move the deal on the
          // board while leaving the drip engine and the timeline blind to it —
          // the two-fields-out-of-sync defect closed earlier today, re-entering
          // from a new direction.
          try {
            // ATOMIC. The guard rides on the same statement that writes
            // (updateRecord's ifMatch), so an operator advancing the deal
            // between the read above and this write loses the race instead of
            // being silently overwritten — a funded deal dragged back to
            // `approved`, which since this morning also restarts the
            // merchant's drip email. A separate "claim" update beforehand does
            // NOT close this; only the condition being on the writing
            // statement does (Codex review P1, 2026-08-12).
            //
            // An ABSENT status is guarded with null, not "". That is the
            // ordinary shopping-phase state, and `data->>status = ''` never
            // matches a missing key, so the naive form would refuse forever on
            // exactly the deals this exists to move.
            await updateRecord({
              ifMatch: {
                field: "status",
                // ONLY undefined/null map to a null precondition. An
                // explicitly stored "" is a real value that `is null` does not
                // match, so collapsing it here would report contention on
                // every attempt and the deal could never route (Codex review
                // P2, 2026-08-12).
                value:
                  statusAtDecision === undefined || statusAtDecision === null
                    ? null
                    : String(statusAtDecision),
              },
              tenant_id: SUNBIZ_TENANT_ID,
              entity: "application",
              id: c.appId,
              patch: {
                status: decision.to,
                lender_reply_needs_review: false,
                lender_reply_review_reason: null,
                routed_by: "lender_reply_scan",
                routed_at: replyAt,
              },
            });
            row.route = `routed: ${decision.to} (${decision.reason})`;
            routed++;
          } catch (e) {
            // A lost CAS is not a failure, it is a human who got there first.
            // Named separately so a real write error stays visible instead of
            // being buried under normal contention.
            const msg = e instanceof Error ? e.message : "unknown";
            const lostRace = /precondition failed/.test(msg);
            row.route = lostRace ? "deferred: status_changed_under_us" : `route_failed: ${msg}`;
            routeDeferred++;

            // REWIND on a genuine failure, for the same reason the flag path
            // does: step 1 already advanced the cursor, so without this a
            // transient database error permanently consumes a clean approval
            // or a unanimous decline while the tick politely reports it as
            // "deferred" (Codex review P1, 2026-08-12).
            //
            // NOT on a lost race. An operator moved the deal deliberately;
            // re-processing would only lose the same race again next tick,
            // forever. That reply is genuinely finished with.
            if (!lostRace && c.thread) {
              await db
                .from("application_lender_threads")
                .update({ last_response_at: c.thread.last_response_at })
                .eq("id", c.thread.id)
                .eq("tenant_id", SUNBIZ_TENANT_ID);
            }
          }
        }
      }
    }

    results.push(row);
  }

  return NextResponse.json({
    ok: true,
    mode: write ? "write" : "dry",
    inbox: creds.fromAddress,
    scanned: results.length,
    /** Deal routing. `armed` false means every clear decision is reported as
     *  `would_route` and nothing moved — the staged go-live state. */
    routing: {
      armed: autoRouteLive(),
      min_confidence: minConfidenceFromEnv(),
      routed,
      would_route: wouldRoute,
      flagged,
      /** Could not decide safely (threads unreadable / write failed). Retried
       *  next tick — never counted as a decision. */
      deferred: routeDeferred,
    },
    /** Candidates eligible for classification this tick. */
    candidates: toClassify.length,
    /** ACTUALLY classified. Previously reported the candidate count, which
     *  overstated the work whenever anything was skipped. */
    classified: classified.length,
    /** Ran out of budget or inference was down — retried next tick, not lost. */
    deferred: deferredSet.size,
    unknown: unknownCount,
    /** Inference genuinely failed. The authoritative outage signal. */
    unavailable: unavailableCount,
    /** Job still in flight past our budget — ordinary latency, collected next
     *  tick via the dedupe key. Explicitly NOT an outage. */
    pending: pendingCount,
    classifier_down: classifierDown,
    /** Legacy key — kept so an un-updated trigger still alerts. */
    dead_key_suspected: deadKeySuspected,
    ...(classifierDown ? { error_class: "inference" as const } : {}),
    applied,
    results,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
