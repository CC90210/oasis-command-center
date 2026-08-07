/**
 * lib/health/drip-checks.ts — the outcome checks for the drip estate.
 *
 * Each check is a query against a table the feature already writes, so a
 * feature nobody remembered to instrument is still covered. The rules live in
 * checks-core.ts and are pure; this file is the I/O.
 *
 * Every check here is derived from a REAL failure observed on 2026-08-06:
 * SMS had been dead for three weeks and email for a day, and the existing
 * watchdog (9 local PM2 processes, 8 of them liveness-only, zero Vercel
 * coverage) reported healthy throughout.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { evaluate, type CheckResult, type CheckRule } from "./checks-core";

type Db = ReturnType<typeof getServiceSupabase>;

export type DripCheck = {
  id: string;
  severity: "critical" | "high" | "medium";
  rule: CheckRule;
  /** Observed value for a window ending at `endMs`. Returns null if the query
   *  itself failed — which evaluate() reports as check_broken, never as ok. */
  observe: (db: Db, tenantId: string, endMs: number) => Promise<number | null>;
  describe: (r: CheckResult) => string;
};

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

export const DRIP_CHECKS: DripCheck[] = [
  {
    // THE check that would have caught the SMS outage on day one, and the one
    // that is impossible to fake: a row claiming it sent, with no provider id
    // and a recorded delivery failure.
    id: "sms.sent_without_proof",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("drip_runs").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("channel", "sms").eq("status", "sent")
          .is("provider_message_id", null).like("last_error", "delivery_failed:%")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) =>
      `${r.observed} SMS row(s) marked sent with no provider message id and a recorded delivery failure. ` +
      `These did NOT reach anyone. This exact condition hid a three-week outage.`,
  },
  {
    id: "sms.delivered_24h",
    severity: "critical",
    rule: { kind: "baseline_drop", failingBelowPct: 0.25, degradedBelowPct: 0.6 },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("lead_interactions").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("type", "sms_sent").eq("direction", "outbound")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) => `SMS sends in the last 24h: ${r.observed} (normal ${r.baseline}). ${r.reason}`,
  },
  {
    id: "email.sent_24h",
    severity: "critical",
    rule: { kind: "baseline_drop", failingBelowPct: 0.25, degradedBelowPct: 0.6 },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("lead_interactions").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("type", "email_sent").eq("direction", "outbound")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) => `Emails sent in the last 24h: ${r.observed} (normal ${r.baseline}). ${r.reason}`,
  },
  {
    // A backlog that stops draining is the shape of a stalled dispatcher, and
    // it is visible before output drops to zero.
    id: "drips.overdue_backlog",
    severity: "high",
    rule: { kind: "must_be_above", floor: -1 }, // never fails on its own; the digest reports it
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("drip_runs").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "scheduled").lt("scheduled_for", iso(endMs)),
      ),
    describe: (r) => `${r.observed} drip row(s) are past their scheduled time.`,
  },
];

/**
 * Run one check across a trailing history so it has a baseline to judge against.
 * `historyDays` samples are taken as consecutive 24h windows ending at `nowMs`.
 */
export async function runCheck(
  db: Db,
  tenantId: string,
  check: DripCheck,
  nowMs: number,
  historyDays = 14,
): Promise<CheckResult> {
  const observed = await check.observe(db, tenantId, nowMs);
  const history: number[] = [];
  if (check.rule.kind === "baseline_drop") {
    // Skip the most recent window: including the outage in its own baseline is
    // how a slow decline normalises itself into invisibility.
    for (let d = 1; d <= historyDays; d++) {
      const v = await check.observe(db, tenantId, nowMs - d * DAY);
      if (v !== null) history.push(v);
    }
  }
  return evaluate(check.id, check.rule, observed, history);
}
