import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

import { EMPTY_PERF, ROW_CAP, summarize, type PerfSummary } from "@/lib/founders-performance-core";

/**
 * The server read behind the Performance tab.
 *
 * This file does one thing: fetch. Every decision about what the result MEANS —
 * failed vs empty, complete vs truncated — lives in
 * lib/founders-performance-core.ts, which imports nothing and is therefore
 * testable. Same split as lib/founders-marketing-core.ts; read the comment in
 * lib/founders/gate.ts for the leak that design prevents.
 *
 * TWO READS, TOGETHER: the window's posts (bounded by ROW_CAP), and when each
 * channel last posted at all (one row per platform). The window alone cannot
 * list a channel that went quiet before it began - TikTok and YouTube vanished
 * from the page after 2026-08-21 - so the second read is what lets the page say
 * "last posted 42 days ago" instead of nothing. They run side by side, so the
 * page waits one round trip, as before.
 */

export async function getPerformance(tenantId: string, days = 30): Promise<PerfSummary> {
  // No tenant is a broken caller, not a quiet tenant. Returning the empty shape
  // here would paint "nothing published yet" over a resolution failure.
  //
  // It has to LOG, too. The page says the numbers could not be loaded and that
  // the cause is logged for the OASIS team; a degraded state that writes
  // nothing leaves whoever investigates looking for an entry that was never
  // written, which is a worse failure than the silence it replaced.
  if (!tenantId) {
    console.warn("[founders:performance] no tenant on the caller — cannot scope the read");
    return { ...EMPTY_PERF, degraded: true };
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const [result, lastPosted] = await Promise.all([
    getServiceSupabase()
      .from("post_analytics")
      .select("*")
      .eq("tenant_id", tenantId)
      .gte("published_at", since)
      .order("published_at", { ascending: false })
      // One more than we will show, purely so summarize() can tell "this is all
      // of it" from "this is the first 500 of more".
      .limit(ROW_CAP + 1),
    readLastPosted(tenantId),
  ]);

  if (result.error) console.warn("[founders:performance]", result.error.message);
  return { ...summarize(result), lastPosted };
}

/**
 * When each channel last posted, all time: platform -> ISO time, one row per
 * platform. The same database the window is read from (the data surface
 * getServiceSupabase routes to Turso); a grouped MAX is not something its
 * PostgREST-style builder can ask for, so this is the libSQL client directly.
 *
 * null when it is not on Turso or the read failed (logged): the page then says
 * it could not check, rather than calling a channel quiet or empty.
 */
async function readLastPosted(tenantId: string): Promise<Record<string, string> | null> {
  if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) return null;
  try {
    const r = await getTursoClient().execute({
      sql: `SELECT platform, MAX(published_at) AS last_posted
              FROM post_analytics
             WHERE tenant_id = ? AND published_at IS NOT NULL
             GROUP BY platform`,
      args: [tenantId],
    });
    const out: Record<string, string> = {};
    for (const row of r.rows) {
      const platform = row.platform;
      const last = row.last_posted;
      if (typeof platform === "string" && typeof last === "string" && last) out[platform] = last;
    }
    return out;
  } catch (e) {
    console.warn("[founders:performance] last post per channel:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
