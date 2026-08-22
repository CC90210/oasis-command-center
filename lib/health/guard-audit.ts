/**
 * lib/health/guard-audit.ts — read each safety mechanism's actual output.
 *
 * Rules are pure and live in guard-audit-core.ts.
 *
 * THE REGISTRY IS DELIBERATELY SMALL AND HONEST. Every instrument here is one
 * whose effect is genuinely visible in data we already store. Adding an entry
 * we cannot really measure would be worse than omitting it: the summary states
 * a denominator, and a padded denominator makes the estate look better covered
 * than it is — which is the same class of comfortable lie as a filter that
 * matches nothing.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { auditInstruments, summarize, type AuditFinding, type InstrumentReading } from "./guard-audit-core";
import { sendTelegram } from "@/lib/notify/telegram";

type Db = ReturnType<typeof getServiceSupabase>;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function countOrNull(q: PromiseLike<{ error: unknown; count: number | null }>): Promise<number | null> {
  try {
    const r = await q;
    if (r.error) return null;
    return r.count ?? 0;
  } catch {
    return null;
  }
}

/** Rows whose last_error contains `needle`, within the window. */
function errorCount(db: Db, tenantId: string, needle: string, startIso: string, endIso: string) {
  return countOrNull(
    db.from("drip_runs").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .like("last_error", `%${needle}%`)
      .gte("created_at", startIso).lt("created_at", endIso),
  );
}

export async function readInstruments(
  tenantId: string,
  opts: { windowMs?: number; endMs?: number } = {},
): Promise<InstrumentReading[]> {
  const db: Db = getServiceSupabase();
  const endMs = opts.endMs ?? Date.now();
  const startMs = endMs - (opts.windowMs ?? 7 * DAY);
  const s = iso(startMs);
  const e = iso(endMs);

  const receiptsOpened = await countOrNull(
    db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).gte("sent_at", s).lt("sent_at", e),
  );
  const receiptsResolved = await countOrNull(
    db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).gte("sent_at", s).lt("sent_at", e)
      .not("resolved_at", "is", null),
  );

  // The thread matcher, expressed as an EXCLUSION rate.
  //
  // `considered` is receipts the reconciler actually looked at (it spent an
  // attempt). `acted` is those it looked at and still could not name — i.e.
  // excluded. All-excluded is bug #1 exactly: on 2026-08-16 the matcher began
  // rejecting every candidate because an optional provider field vanished, and
  // it read as a quiet week.
  const examined = await countOrNull(
    db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).gte("sent_at", s).lt("sent_at", e)
      .gt("check_attempts", 0),
  );
  const examinedUnmatched = await countOrNull(
    db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).gte("sent_at", s).lt("sent_at", e)
      .gt("check_attempts", 0).eq("carrier_status", "unknown"),
  );

  const smsDispatched = await countOrNull(
    db.from("drip_runs").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("channel", "sms")
      .gte("created_at", s).lt("created_at", e),
  );

  const healthRuns = await countOrNull(
    db.from("health_check_runs").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).gte("ran_at", s).lt("ran_at", e),
  );

  return [
    {
      id: "sms.receipt_reconciler",
      considered: receiptsOpened,
      acted: receiptsResolved,
      expectation: "expect_action",
      what: "closes each SMS receipt with what the carrier actually did. Every other SMS guard reads its output",
    },
    {
      id: "sms.thread_matcher",
      considered: examined,
      acted: examinedUnmatched,
      expectation: "must_not_be_total",
      what: "finds our sent message inside the provider's thread. If it matches nothing, delivery becomes unverifiable and looks like silence",
    },
    {
      id: "sms.destination_gate",
      considered: smsDispatched,
      acted: await errorCount(db, tenantId, "sms_unreachable:", s, e),
      expectation: "zero_is_fine",
      what: "stops texts to numbers that cannot receive them (landlines)",
    },
    {
      id: "sms.line_bench",
      considered: smsDispatched,
      acted: await errorCount(db, tenantId, "sms_line_benched", s, e),
      expectation: "zero_is_fine",
      what: "benches one of our sending numbers after repeated carrier failures",
    },
    {
      id: "sms.carrier_breaker",
      considered: smsDispatched,
      acted: await errorCount(db, tenantId, "sms_carrier_halt", s, e),
      expectation: "zero_is_fine",
      what: "halts a whole wire when the route stops delivering",
    },
    {
      id: "sms.optout_suppression",
      considered: smsDispatched,
      acted: await errorCount(db, tenantId, "suppressed (unsubscribed)", s, e),
      expectation: "zero_is_fine",
      what: "refuses to text anyone who replied STOP",
    },
    {
      id: "sms.lawful_basis",
      considered: smsDispatched,
      acted: await errorCount(db, tenantId, "sms_no_lawful_basis", s, e),
      expectation: "zero_is_fine",
      what: "refuses a marketing text with no consent record",
    },
    {
      id: "health.monitor",
      // The watchdog is in its own watch list. A monitor that stopped running
      // silences every check above it, and on 2026-08-06 exactly that happened.
      considered: 1,
      acted: healthRuns,
      expectation: "expect_action",
      what: "runs the health checks themselves",
    },
  ];
}

export type GuardAuditResult = {
  readings: InstrumentReading[];
  findings: AuditFinding[];
  summary: string;
};

export async function runGuardAudit(
  tenantId: string,
  opts: { windowMs?: number; endMs?: number } = {},
): Promise<GuardAuditResult> {
  const readings = await readInstruments(tenantId, opts);
  const findings = auditInstruments(readings);
  return { readings, findings, summary: summarize(readings, findings) };
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Page about broken instruments, at most once a day.
 *
 * The reading is a SEVEN DAY window and the health cron runs every 15 minutes,
 * so alerting per tick would repeat the same sentence 96 times a day and get
 * the channel muted — which is precisely how a real alert goes unread. One
 * message per condition per day is enough for a weekly signal.
 *
 * Uses the standing decay ladder, keyed on the finding id + severity so a
 * mechanism that breaks and stays broken escalates rather than repeats.
 */
export async function announceGuardAudit(
  tenantId: string,
  result: GuardAuditResult,
  opts: { nowMs?: number } = {},
): Promise<{ alerted: string[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const db: Db = getServiceSupabase();
  const alerted: string[] = [];
  const bad = result.findings.filter((f) => f.severity !== "info");
  if (bad.length === 0) return { alerted };

  const key = "guard-audit:broken-instruments";
  const signature = bad.map((f) => `${f.id}:${f.severity}`).sort().join("|");
  const state = await db.from("health_alert_state").select("*").eq("alert_key", key).maybeSingle();
  const row = state.data as { last_signature: string | null; last_alerted_at: string | null; repeat_n: number | null } | null;

  // A DIFFERENT set of broken instruments is a new condition and pages
  // immediately; the same set re-pages on the ladder.
  const lastAt = row?.last_alerted_at ? Date.parse(row.last_alerted_at) : 0;
  const sameCondition = row?.last_signature === signature;
  if (sameCondition && nowMs - lastAt < DAY) return { alerted };

  const body =
    `⚪ <b>GUARD AUDIT</b> — ${esc(result.summary)}\n` +
    bad.map((f) => `· <b>${esc(f.id)}</b>: ${esc(f.message)}`).join("\n") +
    `\n<i>These are the mechanisms themselves, not the outcomes they protect.</i>`;
  await sendTelegram(body, { lane: "sunbiz-ops" }).catch(() => undefined);
  alerted.push(key);

  await db.from("health_alert_state").upsert(
    {
      alert_key: key,
      tenant_id: tenantId,
      last_signature: signature,
      last_alerted_at: new Date(nowMs).toISOString(),
      repeat_n: (row?.repeat_n ?? 0) + 1,
      first_failed_at: sameCondition ? (row?.last_alerted_at ?? new Date(nowMs).toISOString()) : new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    },
    { onConflict: "alert_key" },
  ).then(() => undefined, () => undefined);

  return { alerted };
}
