/**
 * GET/POST /api/cron/kixie-compliance-scan — daily compliance sweep over Kixie
 * Conversation Intelligence call summaries.
 *
 * SunBiz positions as a DIRECT LENDER — reps must never reveal lender
 * relationships on a call. This cron scans lead_interactions rows
 * (agent_source='kixie', type='call_ci_summary') created in the last 26 hours
 * (26 > 24 so consecutive daily runs overlap and nothing slips the seam) for
 * forbidden phrases ("our lenders", "network of funders", ...) plus any
 * tenant-extra phrases from tenants.custom_fields.kixie_compliance_phrases.
 *
 * On hits: ONE consolidated Telegram alert (escaped, ≤80-char context snippet
 * per hit — never a transcript dump) + one agent_events row per flagged call
 * (event_type BRAVO_KIXIE_COMPLIANCE_FLAG) so /feed shows it. Already-flagged
 * calls (an event row exists for the interaction) are not re-alerted on the
 * overlap window.
 *
 * ?mode=weekly additionally computes a per-rep 7-day scorecard (dials /
 * connects / talk time / voicemails / CI sentiment mix) from the Kixie phone
 * interactions and sends it as a compact Telegram digest.
 *
 * Auth: Bearer CRON_SECRET (or SCAN_TRIGGER_SECRET for manual curls),
 * constant-time compare. Fail closed: no secret configured -> 503.
 *
 * Faithful reporting: every swallowed failure (tenant fetch, Telegram send,
 * agent_events insert) is counted + returned in `failures`, and any failure
 * makes the response non-2xx — no silent catch-and-continue.
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram, escapeTelegramHtml } from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCAN_WINDOW_HOURS = 26;
const WEEKLY_WINDOW_DAYS = 7;
const PAGE = 1000;
const MAX_PAGES = 20; // 20k rows/window hard cap — far above real call volume
const MAX_ALERT_ITEMS = 15; // ~220 chars/line keeps the alert under Telegram's 4096 cap
const MAX_TENANT_EXTRA_PHRASES = 50;
const SNIPPET_LEN = 80;
const EVENT_TYPE = "BRAVO_KIXIE_COMPLIANCE_FLAG";

/**
 * Forbidden phrases — the "never mention lenders" doctrine (hardwired
 * 2026-07-10). Case-insensitive; word-bounded so "the lenders" doesn't match
 * inside an unrelated longer token.
 */
const BASE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "our lenders", re: /\bour lenders\b/i },
  { label: "our lender network", re: /\bour lender network\b/i },
  { label: "network of lenders", re: /\bnetwork of lenders\b/i },
  { label: "lenders we work with", re: /\blenders we work with\b/i },
  { label: "our lending partners", re: /\bour lending partners\b/i },
  { label: "our funders", re: /\bour funders\b/i },
  { label: "network of funders", re: /\bnetwork of funders\b/i },
  { label: "the lenders", re: /\bthe lenders\b/i },
  {
    label: "submit ... to lenders",
    re: /\bsubmit (?:it|this|your file) to (?:our |the )?lenders?\b/i,
  },
];

function checkAuth(req: NextRequest): NextResponse | null {
  const secrets = [process.env.CRON_SECRET, process.env.SCAN_TRIGGER_SECRET].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (secrets.length === 0) {
    // Fail closed — refuse to run rather than run unauthenticated.
    return NextResponse.json(
      { ok: false, error: "cron_not_configured", detail: "CRON_SECRET is not set." },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  for (const secret of secrets) {
    const a = Buffer.from(bearer);
    const b = Buffer.from(secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
  }
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

/** Escape regex metacharacters so tenant-extra phrases match literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** ≤SNIPPET_LEN chars of context around the first match — never the transcript. */
function snippetAround(content: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 25);
  return content
    .slice(start, start + SNIPPET_LEN)
    .replace(/\s+/g, " ")
    .trim();
}

type InteractionRow = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  type: string;
  content: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  kixie_call_id: string | null;
  call_duration_sec: number | null;
  call_outcome: string | null;
};

type DB = ReturnType<typeof getServiceSupabase>;

/** Page through lead_interactions with the given filters. Throws on DB error. */
async function fetchInteractions(
  db: DB,
  sinceIso: string,
  filters: { type?: string; channel?: string },
): Promise<InteractionRow[]> {
  const rows: InteractionRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db
      .from("lead_interactions")
      .select(
        "id, tenant_id, lead_id, type, content, created_at, metadata, kixie_call_id, call_duration_sec, call_outcome",
      )
      .eq("agent_source", "kixie")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (filters.type) q = q.eq("type", filters.type);
    if (filters.channel) q = q.eq("channel", filters.channel);
    const r = await q;
    if (r.error) throw new Error(`lead_interactions fetch failed: ${r.error.message}`);
    const batch = (r.data || []) as InteractionRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

type Flag = {
  interaction_id: string;
  tenant_id: string;
  rep_email: string;
  lead_id: string | null;
  matched_phrases: string[];
  snippet: string;
  created_at: string;
};

function fmtWhen(iso: string): string {
  // 2026-07-21T14:03:22.000Z -> 2026-07-21 14:03 UTC
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function fmtTalk(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export async function GET(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const weekly = url.searchParams.get("mode") === "weekly";
  const db = getServiceSupabase();
  const failures: string[] = [];

  // ── Phase 1: pull the CI summaries in the scan window ─────────────────────
  const sinceIso = new Date(Date.now() - SCAN_WINDOW_HOURS * 3600_000).toISOString();
  let summaries: InteractionRow[];
  try {
    summaries = await fetchInteractions(db, sinceIso, { type: "call_ci_summary" });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "fetch_failed" },
      { status: 500 },
    );
  }

  // ── Phase 2: tenant-extra phrases (tenants.custom_fields.kixie_compliance_phrases)
  const tenantIds = Array.from(new Set(summaries.map((r) => r.tenant_id)));
  const extraByTenant = new Map<string, Array<{ label: string; re: RegExp }>>();
  if (tenantIds.length > 0) {
    const tr = await db.from("tenants").select("id, custom_fields").in("id", tenantIds);
    if (tr.error) {
      // Count it — the scan still runs on the base list, but a partial scan is
      // a reportable failure, not a silent downgrade.
      failures.push(`tenant_phrases_fetch_failed: ${tr.error.message}`);
    } else {
      for (const t of (tr.data || []) as Array<{ id: string; custom_fields: Record<string, unknown> | null }>) {
        const raw = t.custom_fields?.kixie_compliance_phrases;
        if (!Array.isArray(raw)) continue;
        const patterns: Array<{ label: string; re: RegExp }> = [];
        for (const p of raw.slice(0, MAX_TENANT_EXTRA_PHRASES)) {
          if (typeof p !== "string") continue;
          const phrase = p.trim().slice(0, 120);
          if (!phrase) continue;
          patterns.push({ label: phrase, re: new RegExp(escapeRegExp(phrase), "i") });
        }
        if (patterns.length) extraByTenant.set(t.id, patterns);
      }
    }
  }

  // ── Phase 3: scan ─────────────────────────────────────────────────────────
  const flags: Flag[] = [];
  let emptyContent = 0;
  for (const row of summaries) {
    const content = typeof row.content === "string" ? row.content : "";
    if (!content) {
      emptyContent += 1;
      continue;
    }
    const patterns = [...BASE_PATTERNS, ...(extraByTenant.get(row.tenant_id) || [])];
    const matched: string[] = [];
    let firstIndex = -1;
    for (const p of patterns) {
      const m = p.re.exec(content);
      if (m) {
        matched.push(p.label);
        if (firstIndex < 0 || m.index < firstIndex) firstIndex = m.index;
      }
    }
    if (matched.length === 0) continue;
    const meta = row.metadata || {};
    flags.push({
      interaction_id: row.id,
      tenant_id: row.tenant_id,
      rep_email:
        typeof meta.kixie_agent_email === "string" && meta.kixie_agent_email
          ? meta.kixie_agent_email
          : "(unknown rep)",
      lead_id: row.lead_id,
      matched_phrases: matched,
      snippet: snippetAround(content, Math.max(0, firstIndex)),
      created_at: row.created_at,
    });
  }

  // ── Phase 4: dedupe against already-flagged calls (26h window overlaps) ───
  let newFlags = flags;
  let alreadyFlagged = 0;
  if (flags.length > 0) {
    const lookback = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const ex = await db
      .from("agent_events")
      .select("payload")
      .eq("event_type", EVENT_TYPE)
      .gte("created_at", lookback);
    if (ex.error) {
      // Fail toward alerting (a duplicate ping beats a missed violation) but
      // count the degraded dedup as a failure.
      failures.push(`flag_dedup_fetch_failed: ${ex.error.message}`);
    } else {
      const seen = new Set(
        ((ex.data || []) as Array<{ payload: Record<string, unknown> | null }>)
          .map((r) => String(r.payload?.interaction_id || ""))
          .filter(Boolean),
      );
      newFlags = flags.filter((f) => !seen.has(f.interaction_id));
      alreadyFlagged = flags.length - newFlags.length;
    }
  }

  // ── Phase 5: agent_events row per flagged call + ONE consolidated alert ───
  let eventsInserted = 0;
  for (const f of newFlags) {
    const { error } = await db.from("agent_events").insert({
      event_type: EVENT_TYPE,
      publisher_agent: "kixie-compliance",
      severity: "warn",
      payload: {
        tenant_id: f.tenant_id,
        interaction_id: f.interaction_id,
        rep_email: f.rep_email,
        lead_id: f.lead_id,
        matched_phrases: f.matched_phrases,
        snippet: f.snippet,
        created_at: f.created_at,
      },
      correlation_id: f.tenant_id,
    });
    if (error) failures.push(`agent_events_insert_failed:${f.interaction_id}: ${error.message}`);
    else eventsInserted += 1;
  }

  let alertSent = false;
  if (newFlags.length > 0) {
    const shown = newFlags.slice(0, MAX_ALERT_ITEMS);
    const lines = shown.map((f) => {
      const lead = f.lead_id ? f.lead_id.slice(0, 8) : "no-lead";
      return (
        `• <b>${escapeTelegramHtml(f.rep_email)}</b> — lead <code>${escapeTelegramHtml(lead)}</code>` +
        ` — "${escapeTelegramHtml(f.matched_phrases.join('", "'))}" — ${escapeTelegramHtml(fmtWhen(f.created_at))}\n` +
        `  <i>…${escapeTelegramHtml(f.snippet)}…</i>`
      );
    });
    const more = newFlags.length > shown.length ? `\n…and ${newFlags.length - shown.length} more (see /feed).` : "";
    const msg =
      `🚨 <b>Kixie compliance flags</b> — ${newFlags.length} call${newFlags.length === 1 ? "" : "s"} ` +
      `mentioned lender relationships in the last ${SCAN_WINDOW_HOURS}h:\n\n` +
      lines.join("\n") +
      more;
    const tg = await sendTelegram(msg);
    if (!tg.ok) failures.push(`telegram_alert_failed: ${tg.reason || "unknown"}`);
    else alertSent = true;
  }

  // ── Phase 6 (?mode=weekly): per-rep 7-day scorecard digest ────────────────
  let weeklyOut: Array<Record<string, unknown>> | undefined;
  if (weekly) {
    try {
      const weekIso = new Date(Date.now() - WEEKLY_WINDOW_DAYS * 24 * 3600_000).toISOString();
      const calls = await fetchInteractions(db, weekIso, { channel: "phone" });

      type RepStats = {
        dials: Set<string>;
        connects: number;
        talkSec: number;
        voicemails: number;
        sentiment: Map<string, number>;
      };
      const reps = new Map<string, RepStats>();
      for (const row of calls) {
        const meta = row.metadata || {};
        const rep =
          typeof meta.kixie_agent_email === "string" && meta.kixie_agent_email
            ? meta.kixie_agent_email
            : "(unknown)";
        let s = reps.get(rep);
        if (!s) {
          s = { dials: new Set(), connects: 0, talkSec: 0, voicemails: 0, sentiment: new Map() };
          reps.set(rep, s);
        }
        // Dials = unique kixie_call_id; a row missing one still counts once.
        s.dials.add(row.kixie_call_id || `row:${row.id}`);
        const dur = typeof row.call_duration_sec === "number" ? row.call_duration_sec : 0;
        if (row.type === "call_answered" || dur >= 30) s.connects += 1;
        s.talkSec += dur;
        if (row.type === "call_voicemail" || row.call_outcome === "voicemail") s.voicemails += 1;
        const senti = typeof meta.ci_sentiment === "string" && meta.ci_sentiment ? meta.ci_sentiment.toLowerCase() : "";
        if (senti) s.sentiment.set(senti, (s.sentiment.get(senti) || 0) + 1);
      }

      weeklyOut = Array.from(reps.entries())
        .sort((a, b) => b[1].dials.size - a[1].dials.size)
        .map(([rep, s]) => ({
          rep,
          dials: s.dials.size,
          connects: s.connects,
          talk_time_sec: s.talkSec,
          voicemails: s.voicemails,
          sentiment: Object.fromEntries(s.sentiment),
        }));

      if (weeklyOut.length > 0) {
        const header = "Rep                    Dials Conn  Talk   VM";
        const rows = weeklyOut.map((r) => {
          const senti = Object.entries(r.sentiment as Record<string, number>)
            .map(([k, v]) => `${k.slice(0, 3)}:${v}`)
            .join(" ");
          return (
            String(r.rep).slice(0, 22).padEnd(22) +
            String(r.dials).padStart(5) +
            String(r.connects).padStart(5) +
            fmtTalk(Number(r.talk_time_sec)).padStart(7) +
            String(r.voicemails).padStart(4) +
            (senti ? `  ${senti}` : "")
          );
        });
        const digest =
          `📊 <b>Kixie rep scorecard</b> — last ${WEEKLY_WINDOW_DAYS} days\n` +
          `<pre>${escapeTelegramHtml([header, ...rows].join("\n"))}</pre>`;
        const tg = await sendTelegram(digest);
        if (!tg.ok) failures.push(`telegram_digest_failed: ${tg.reason || "unknown"}`);
      }
    } catch (e) {
      failures.push(`weekly_scorecard_failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  const body = {
    ok: failures.length === 0,
    mode: weekly ? "weekly" : "daily",
    window_hours: SCAN_WINDOW_HOURS,
    scanned: summaries.length,
    empty_content: emptyContent,
    flagged: flags.length,
    new_flags: newFlags.length,
    already_flagged: alreadyFlagged,
    events_inserted: eventsInserted,
    alert_sent: alertSent,
    flags: newFlags.map((f) => ({
      interaction_id: f.interaction_id,
      rep_email: f.rep_email,
      lead_id: f.lead_id,
      matched_phrases: f.matched_phrases,
      created_at: f.created_at,
    })),
    ...(weeklyOut ? { weekly: weeklyOut } : {}),
    failures,
  };
  // Any swallowed failure surfaces as non-2xx so the cron monitor sees it.
  return NextResponse.json(body, { status: failures.length === 0 ? 200 : 500 });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
