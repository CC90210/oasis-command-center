/**
 * GET/POST /api/cron/collect-outreach-intel — the outreach intelligence collector.
 *
 * Pulls TextTorrent campaign analytics, snapshots per-message rosters (delivery +
 * native replies), attributes conversions against the lead funnel, rolls up
 * per-number health + per-list scoring, and fires spammy-number / dead-list alerts.
 *
 * Auth: Bearer SCAN_TRIGGER_SECRET (same secret the offers-scanner uses), so a
 * PM2 worker or a manual curl can drive it. DRY-RUN unless ?write=1 — dry-run
 * computes + returns JSON, persists nothing. ?campaign=<id> recomputes one.
 *
 * Rate-budgeted: deep-fetches at most DEEP_FETCH_CAP campaigns per run (≈3 TT
 * calls each) under TT's 60/min shared limit.
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  getTextTorrentCredentials,
  listCampaigns,
  campaignDetails,
  campaignCount,
  campaignMessageList,
} from "@/lib/integrations/texttorrent";
import { sendTelegram } from "@/lib/notify/telegram";
import { postMessageDb } from "@/lib/agent-inbox-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TENANT_ID = process.env.TEXTTORRENT_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const DEEP_FETCH_CAP = Number(process.env.INTEL_DEEP_FETCH_CAP || 12);
const ROSTER_PAGE_CAP = Number(process.env.INTEL_ROSTER_PAGE_CAP || 12);
const PAGE_SIZE = 100;

// Alert thresholds (env-tunable).
const SPAM_FAIL_RATE = Number(process.env.INTEL_SPAM_FAIL_RATE || 20); // %
const WATCH_FAIL_RATE = Number(process.env.INTEL_WATCH_FAIL_RATE || 10);
const MIN_SENDS_HEALTH = Number(process.env.INTEL_MIN_SENDS_HEALTH || 50);
const DEAD_LIST_MIN_SENT = Number(process.env.INTEL_DEAD_MIN_SENT || 200);
const ALERT_COOLDOWN_H = Number(process.env.INTEL_ALERT_COOLDOWN_H || 12);

const last10 = (p: unknown) => String(p || "").replace(/\D/g, "").slice(-10);
const isDelivered = (s?: string) => s === "delivered" || s === "sent";
const isFailed = (s?: string) => s === "failed" || s === "undelivered";

// Conversion stages: engaged = reached the application path; funded = money out.
const ENGAGED_STAGES = new Set([
  "sent_application", "viewed_application", "signed_application", "submitted_application",
  "shopping", "docs_out", "requested_docs", "approved", "funded",
]);
const FUNDED_STAGES = new Set(["approved", "funded"]);
const stageRank = (s: string) => (FUNDED_STAGES.has(s) ? 3 : ENGAGED_STAGES.has(s) ? 2 : 1);

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.SCAN_TRIGGER_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type DB = ReturnType<typeof getServiceSupabase>;

/** Build last10(phone) → best deal stage, from the tenant's leads + applications. */
async function buildStageMap(db: DB): Promise<Map<string, { stage: string; lead_id: string | null }>> {
  const map = new Map<string, { stage: string; lead_id: string | null }>();
  for (const entity of ["lead", "application"]) {
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const r = await db
        .from("tenant_records")
        .select("id,data")
        .eq("tenant_id", TENANT_ID)
        .eq("entity_type", entity)
        .range(from, from + PAGE - 1);
      const rows = (r.data || []) as Array<{ id: string; data: Record<string, unknown> }>;
      for (const row of rows) {
        const d = row.data || {};
        const ph = last10(d.phone);
        if (!ph) continue;
        const stage = String((entity === "application" ? d.status || d.stage : d.stage) || "");
        const cur = map.get(ph);
        if (!cur || stageRank(stage) > stageRank(cur.stage)) {
          map.set(ph, { stage, lead_id: entity === "lead" ? row.id : cur?.lead_id ?? null });
        }
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  return map;
}

async function countRecipients(
  db: DB,
  sendFrom: string,
  opts: { statusIn?: string[]; received?: boolean } = {},
): Promise<number> {
  let q = db
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .eq("send_from", sendFrom);
  if (opts.statusIn) q = q.in("send_status", opts.statusIn);
  if (opts.received !== undefined) q = q.eq("received", opts.received);
  const r = await q;
  return r.count || 0;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const write = url.searchParams.get("write") === "1";
  const onlyCampaign = url.searchParams.get("campaign");
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();
  const alerts: string[] = [];

  try {
    const creds = await getTextTorrentCredentials(TENANT_ID);
    const campaigns = (await listCampaigns(creds, { limit: 50 })).data || [];
    const toProcess = onlyCampaign
      ? campaigns.filter((c) => String(c.id) === onlyCampaign)
      : campaigns.slice(0, DEEP_FETCH_CAP);

    const stageMap = await buildStageMap(db);
    const runs = ((await db.from("campaign_runs").select("tt_campaign_id,list_name,list_id").eq("tenant_id", TENANT_ID)).data || []) as Array<{ tt_campaign_id: string; list_name: string | null; list_id: string | null }>;
    const runByCampaign = new Map(runs.map((r) => [String(r.tt_campaign_id), r]));

    const perList = new Map<string, { name: string; campaigns: Set<string>; sent: number; replies: number; conversions: number; lastAt: number | null }>();
    const sendFromSeen = new Set<string>();
    const results: Array<Record<string, unknown>> = [];

    for (const c of toProcess) {
      const cid = String(c.id);
      const details = await campaignDetails(creds, cid).then((r) => r.data).catch(() => null);
      const counts = await campaignCount(creds, cid).then((r) => r.data).catch(() => null);
      const msgs = [];
      for (let page = 1; page <= ROSTER_PAGE_CAP; page++) {
        const r = await campaignMessageList(creds, cid, { limit: PAGE_SIZE, page });
        msgs.push(...r.data);
        if (r.data.length < PAGE_SIZE) break;
      }

      let replyCount = 0;
      let convCount = 0;
      let fundedCount = 0;
      const recipientRows: Record<string, unknown>[] = [];
      for (const m of msgs) {
        if (m.send_from) sendFromSeen.add(m.send_from);
        const replied = m.received === 1 || (m.received_message != null && m.received_message !== "");
        if (replied) replyCount += 1;
        const l10 = last10(m.send_to);
        const conv = stageMap.get(l10);
        const convStage = conv?.stage || null;
        if (convStage && ENGAGED_STAGES.has(convStage)) convCount += 1;
        if (convStage && FUNDED_STAGES.has(convStage)) fundedCount += 1;
        recipientRows.push({
          tenant_id: TENANT_ID, tt_campaign_id: cid, send_to: m.send_to, send_to_last10: l10,
          send_from: m.send_from, send_status: m.send_status, received: replied,
          received_message: m.received_message || null, lead_id: conv?.lead_id || null,
          conversion_stage: convStage, last_status_at: nowIso,
        });
      }
      const total = counts?.total ?? msgs.length;
      const delivered = counts?.completed ?? msgs.filter((m) => isDelivered(m.send_status)).length;
      const failed = counts?.failed ?? msgs.filter((m) => isFailed(m.send_status)).length;
      const sampled = msgs.length;
      const replyRate = sampled ? +((replyCount / sampled) * 100).toFixed(1) : 0;
      const convRate = sampled ? +((convCount / sampled) * 100).toFixed(1) : 0;

      const listId = String(c.contact_list_id || runByCampaign.get(cid)?.list_id || "");
      const listName = c.contact_list_name || runByCampaign.get(cid)?.list_name || "";
      if (listId) {
        const L = perList.get(listId) || { name: listName, campaigns: new Set<string>(), sent: 0, replies: 0, conversions: 0, lastAt: null };
        L.campaigns.add(cid);
        L.sent += sampled;
        L.replies += replyCount;
        L.conversions += convCount;
        if (!L.name && listName) L.name = listName;
        const cAt = c.created_at ? new Date(c.created_at).getTime() : null;
        if (cAt && (!L.lastAt || cAt > L.lastAt)) L.lastAt = cAt;
        perList.set(listId, L);
      }

      if (write) {
        for (let i = 0; i < recipientRows.length; i += 500) {
          await db.from("campaign_recipients").upsert(recipientRows.slice(i, i + 500), { onConflict: "tt_campaign_id,send_to_last10" });
        }
        await db.from("campaign_metric_snapshots").insert({
          tenant_id: TENANT_ID, tt_campaign_id: cid, total, delivered, failed,
          reply_count: replyCount, reply_rate: replyRate, conversion_count: convCount,
          conversion_rate: convRate, credits_consumed: details?.credits_consumed ?? null,
          status: details?.status || c.status || null,
        });
      }
      results.push({ cid, name: c.campaign_name, total, delivered, failed, replyCount, replyRate, convCount, fundedCount });
    }

    // ---- Per-number health (global, from the persisted roster) + spammy alert ----
    const numberHealth: Array<Record<string, unknown>> = [];
    if (write) {
      for (const sf of sendFromSeen) {
        const sent = await countRecipients(db, sf);
        if (!sent) continue;
        const failedN = await countRecipients(db, sf, { statusIn: ["failed", "undelivered"] });
        const repliesN = await countRecipients(db, sf, { received: true });
        const deliveredN = await countRecipients(db, sf, { statusIn: ["delivered", "sent"] });
        const failureRate = +((failedN / sent) * 100).toFixed(1);
        const replyRate = +((repliesN / sent) * 100).toFixed(1);
        const health = failureRate >= SPAM_FAIL_RATE ? "spammy" : failureRate >= WATCH_FAIL_RATE ? "watch" : "healthy";

        const existing = ((await db.from("campaign_number_health").select("last_alerted_at,last_alert_signature").eq("tenant_id", TENANT_ID).eq("send_from", sf).eq("window_key", "global").maybeSingle()).data) as { last_alerted_at?: string; last_alert_signature?: string } | null;
        await db.from("campaign_number_health").upsert({
          tenant_id: TENANT_ID, send_from: sf, window_key: "global", sent, delivered: deliveredN,
          failed: failedN, replies: repliesN, failure_rate: failureRate, reply_rate: replyRate,
          health, last_computed_at: nowIso,
          last_alerted_at: existing?.last_alerted_at ?? null, last_alert_signature: existing?.last_alert_signature ?? null,
        }, { onConflict: "tenant_id,send_from,window_key" });

        if (health === "spammy" && sent >= MIN_SENDS_HEALTH) {
          const sig = `spammy:${Math.round(failureRate)}`;
          const cooled = !existing?.last_alerted_at || (Date.now() - new Date(existing.last_alerted_at).getTime()) > ALERT_COOLDOWN_H * 3600_000;
          if ((existing?.last_alert_signature !== sig || cooled)) {
            alerts.push(`spammy_number:${sf}`);
            if (write) {
              const body = `🚨 Sending number ${sf} is getting blocked — ${failureRate}% failure across ${sent} sends. Rotate it out of the campaign pool.`;
              await sendTelegram(body).catch(() => {});
              await postMessageDb({ tenantId: TENANT_ID, from: "outreach-intel", to: "owner", subject: `Number ${sf} going spammy (${failureRate}% fail)`, body, priority: "high" }).catch(() => {});
              await db.from("campaign_number_health").update({ last_alerted_at: nowIso, last_alert_signature: sig }).eq("tenant_id", TENANT_ID).eq("send_from", sf).eq("window_key", "global");
            }
          }
        }
        numberHealth.push({ send_from: sf, sent, failureRate, replyRate, health });
      }
    }

    // ---- Per-list intelligence + dead-list alert ----
    const lists: Array<Record<string, unknown>> = [];
    if (write) {
      // normalize score across this run's lists
      const scored = [...perList.entries()].map(([lid, L]) => {
        const replyRate = L.sent ? (L.replies / L.sent) * 100 : 0;
        const convRate = L.sent ? (L.conversions / L.sent) * 100 : 0;
        const score = +(0.6 * convRate + 0.4 * replyRate).toFixed(2);
        const verdict = L.sent >= DEAD_LIST_MIN_SENT && convRate === 0 && replyRate < 1 ? "dead" : score >= 3 ? "recommended" : "average";
        return { lid, L, replyRate: +replyRate.toFixed(1), convRate: +convRate.toFixed(1), score, verdict };
      });
      for (const s of scored) {
        const existing = ((await db.from("list_intelligence").select("last_alerted_at,verdict").eq("tenant_id", TENANT_ID).eq("list_id", s.lid).maybeSingle()).data) as { last_alerted_at?: string; verdict?: string } | null;
        await db.from("list_intelligence").upsert({
          tenant_id: TENANT_ID, list_id: s.lid, list_name: s.L.name || null,
          campaigns_count: s.L.campaigns.size, total_sent: s.L.sent, total_replies: s.L.replies,
          total_conversions: s.L.conversions, reply_rate: s.replyRate, conversion_rate: s.convRate,
          score: s.score, verdict: s.verdict, last_campaign_at: s.L.lastAt ? new Date(s.L.lastAt).toISOString() : null,
          last_computed_at: nowIso, last_alerted_at: existing?.last_alerted_at ?? null,
        }, { onConflict: "tenant_id,list_id" });

        if (s.verdict === "dead" && existing?.verdict !== "dead") {
          alerts.push(`dead_list:${s.lid}`);
          const body = `📉 List "${s.L.name || s.lid}" looks dead — ${s.L.sent} sent, ${s.replyRate}% reply, ${s.convRate}% conversion. Stop blasting it.`;
          await sendTelegram(body).catch(() => {});
          await postMessageDb({ tenantId: TENANT_ID, from: "outreach-intel", to: "owner", subject: `Dead list: ${s.L.name || s.lid}`, body, priority: "normal" }).catch(() => {});
          await db.from("list_intelligence").update({ last_alerted_at: nowIso }).eq("tenant_id", TENANT_ID).eq("list_id", s.lid);
        }
        lists.push({ list_id: s.lid, name: s.L.name, sent: s.L.sent, replyRate: s.replyRate, convRate: s.convRate, score: s.score, verdict: s.verdict });
      }
    }

    return NextResponse.json({ ok: true, write, processed: results.length, results, numberHealth, lists, alerts });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
