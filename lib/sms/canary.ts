/**
 * lib/sms/canary.ts — commission a phone line by proving it delivers.
 *
 * Rules live in canary-core.ts and are pure. This is the I/O: enumerate the
 * lines we own, send one test message per line, and read back what the carrier
 * said.
 *
 * IT DELIBERATELY REUSES sms_delivery_receipts. A private table would let a
 * canary pass while the receipt pipeline the drips depend on stayed broken,
 * which is precisely what happened between 2026-08-16 and 08-20: receipts
 * silently stopped resolving and every guard downstream went blind while
 * reporting healthy. Sharing the table means a passing canary is also evidence
 * that reconciliation itself is alive.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTextTorrentCredentials, sendSms } from "@/lib/integrations/texttorrent";
import { openReceipt } from "./delivery-receipts";
import { lineVerdict, type CanaryAttempt, type LineResult } from "./canary-core";

type Db = ReturnType<typeof getServiceSupabase>;

/** One sendable line, with everything needed to authenticate as its owner. */
export type CanaryLine = {
  number: string;
  /** rep_key: 'ai_followup' | 'alex' | 'jordan' | 'admin'. */
  wire: string;
  actAsEmail: string;
  /** Which TextTorrent ACCOUNT owns it. */
  service: string;
};

/**
 * The test message.
 *
 * Written to be unmistakably a test to whoever receives it, and deliberately
 * SHORT: a two-segment message costs double and, more importantly, varies the
 * delivery path. The thing being measured is the line, so the message must not
 * be a variable.
 */
export function canaryBody(now: Date): string {
  return `SunBiz line test ${now.toISOString().slice(11, 16)} UTC. No action needed.`;
}

export type CanarySendResult = {
  line: CanaryLine;
  ok: boolean;
  chatId?: string;
  error?: string;
};

/**
 * Send one canary per line.
 *
 * Never throws for a single line: one unsendable line must not abort the sweep,
 * because the whole purpose is to compare lines against each other. A line that
 * cannot even be sent on is reported as an error and, having produced no
 * receipt, can never be counted as cleared.
 */
export async function sendCanaries(
  tenantId: string,
  lines: CanaryLine[],
  toPhone: string,
  opts: { now?: Date } = {},
): Promise<CanarySendResult[]> {
  const db: Db = getServiceSupabase();
  const now = opts.now ?? new Date();
  const body = canaryBody(now);
  const out: CanarySendResult[] = [];

  for (const line of lines) {
    try {
      const creds = await getTextTorrentCredentials(tenantId, {
        service: line.service,
        actAsEmail: line.actAsEmail,
      });
      const res = await sendSms(creds, { number: toPhone, message: body, sender_id: line.number });
      const chatId = String(res?.data?.chat_id || "");
      if (!chatId) {
        // No chat id means nothing to reconcile against later, so this attempt
        // can never resolve. Reporting it as sent would create a receipt that
        // is permanently unresolvable.
        out.push({ line, ok: false, error: "provider returned no chat id" });
        continue;
      }
      await openReceipt(db, {
        tenantId,
        dripRunId: null,
        leadId: null,
        chatId,
        repKey: line.wire,
        actAsEmail: line.actAsEmail,
        fromNumber: line.number,
        toPhone,
        body,
        sentAt: now,
        purpose: "canary",
      });
      out.push({ line, ok: true, chatId });
    } catch (err) {
      out.push({ line, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * What the carrier has said about each line so far.
 *
 * Reads only `purpose='canary'` rows, so merchant traffic can neither clear a
 * line nor bench one. The two must stay separable: a merchant with a
 * disconnected handset is not evidence about the line.
 */
export async function canaryStatus(
  tenantId: string,
  opts: { sinceMs?: number; lines?: string[] } = {},
): Promise<{ results: LineResult[]; error: string | null }> {
  const db: Db = getServiceSupabase();
  const since = new Date(opts.sinceMs ?? Date.now() - 7 * 24 * 3_600_000).toISOString();

  let q = db
    .from("sms_delivery_receipts")
    .select("from_number, sent_at, carrier_status, resolved_at")
    .eq("tenant_id", tenantId)
    .eq("purpose", "canary")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(500);
  if (opts.lines && opts.lines.length > 0) q = q.in("from_number", opts.lines);

  const res = await q;
  if (res.error) {
    // Never degrade to "no attempts". An unreadable history is indistinguishable
    // from an untested line only if we let it be, and one of those two is safe
    // to send on after more testing while the other is a broken database.
    return { results: [], error: res.error.message };
  }

  const byLine = new Map<string, CanaryAttempt[]>();
  for (const r of (res.data || []) as Array<{ from_number: string | null; sent_at: string; carrier_status: string | null; resolved_at: string | null }>) {
    const number = String(r.from_number ?? "");
    if (!number) continue;
    const list = byLine.get(number) ?? [];
    list.push({ number, sentAt: r.sent_at, carrierStatus: r.carrier_status, resolvedAt: r.resolved_at });
    byLine.set(number, list);
  }

  // Lines that were asked about but have NO attempts still get a row, so an
  // untested line is visible as untested rather than absent from the report.
  for (const n of opts.lines ?? []) if (!byLine.has(n)) byLine.set(n, []);

  const results: LineResult[] = [];
  for (const [number, attempts] of byLine) {
    results.push({ ...lineVerdict(attempts), number });
  }
  results.sort((a, b) => a.number.localeCompare(b.number));
  return { results, error: null };
}
