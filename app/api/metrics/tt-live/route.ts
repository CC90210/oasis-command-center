/**
 * GET /api/metrics/tt-live — on-demand live Text Torrent account snapshot for the
 * Metrics tab's Text Torrent panel: credit balance + recent campaigns. Fetched
 * client-side only when that tab is opened (NOT on every page load) so it doesn't
 * burn the shared 60-req/min TT rate limit. Session-gated; best-effort (never
 * throws — returns nulls/empty on any TT hiccup).
 */
import { NextRequest, NextResponse } from "next/server";
import { getActiveProfile } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import { getTextTorrentCredentials } from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = "https://api.texttorrent.com/api/v1";

export async function GET(_req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const profile = await getActiveProfile();
  const tenantId = profile?.tenant_id || "";
  if (!tenantId) return NextResponse.json({ ok: false, error: "no_tenant" });

  let creds;
  try {
    // Parent account (actAsEmail:null) — credits + campaigns are account-level.
    creds = await getTextTorrentCredentials(tenantId, { actAsEmail: null });
  } catch {
    return NextResponse.json({ ok: false, error: "no_tt_creds" });
  }
  const H = { "X-API-SID": creds.apiSid, "X-API-PUBLIC-KEY": creds.publicKey, "Content-Type": "application/json" };
  const sig = () => AbortSignal.timeout(8000);

  const [meRes, campRes] = await Promise.allSettled([
    fetch(`${BASE}/user/auth/me`, { method: "POST", headers: H, body: "{}", signal: sig() }).then((r) => r.json()),
    fetch(`${BASE}/campaigning/analytic?limit=8`, { headers: H, signal: sig() }).then((r) => r.json()),
  ]);

  let credits: number | null = null, plan: number | null = null, subAccounts: number | null = null, company: string | null = null;
  if (meRes.status === "fulfilled") {
    const d = (meRes.value?.data || meRes.value || {}) as Record<string, unknown>;
    credits = typeof d.credits === "number" ? d.credits : null;
    plan = typeof d.current_tier === "number" ? d.current_tier : null;
    subAccounts = typeof d.sub_accounts === "number" ? d.sub_accounts : null;
    company = typeof d.company_name === "string" ? d.company_name : null;
  }

  const campaigns: Array<{ id: string; name: string; status: string; createdAt: string; list: string }> = [];
  if (campRes.status === "fulfilled") {
    const list = (campRes.value?.data?.data || campRes.value?.data || []) as Array<Record<string, unknown>>;
    for (const c of (Array.isArray(list) ? list : []).slice(0, 8)) {
      campaigns.push({
        id: String(c.id ?? ""),
        name: String(c.campaign_name || `Campaign ${c.id}`),
        status: String(c.status || ""),
        createdAt: String(c.created_at || ""),
        list: String(c.contact_list_name || ""),
      });
    }
  }

  return NextResponse.json({ ok: true, credits, plan, subAccounts, company, campaigns });
}
