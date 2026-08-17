import { getServiceSupabase } from "@/lib/supabase-server";

import { EMPTY_PERF, ROW_CAP, summarize, type PerfSummary } from "@/lib/founders-performance-core";

/**
 * The server read behind the Performance tab.
 *
 * This file does one thing: fetch. Every decision about what the result MEANS —
 * failed vs empty, complete vs truncated — lives in
 * lib/founders-performance-core.ts, which imports nothing and is therefore
 * testable. Same split as lib/founders-marketing-core.ts; read the comment in
 * lib/founders/gate.ts for the leak that design prevents.
 */

export async function getPerformance(tenantId: string, days = 30): Promise<PerfSummary> {
  // No tenant is a broken caller, not a quiet tenant. Returning the empty shape
  // here would paint "nothing published yet" over a resolution failure.
  //
  // It has to LOG, too. The page tells the reader the reason is in the server
  // log under [founders:performance] — a degraded state that writes nothing
  // sends them looking for an entry that was never written, which is a worse
  // failure than the silence it replaced.
  if (!tenantId) {
    console.warn("[founders:performance] no tenant on the caller — cannot scope the read");
    return { ...EMPTY_PERF, degraded: true };
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await getServiceSupabase()
    .from("post_analytics")
    .select("*")
    .eq("tenant_id", tenantId)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    // One more than we will show, purely so summarize() can tell "this is all
    // of it" from "this is the first 500 of more".
    .limit(ROW_CAP + 1);

  if (result.error) console.warn("[founders:performance]", result.error.message);
  return summarize(result);
}
