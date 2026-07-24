import { NextRequest, NextResponse } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORT_COLUMNS = new Set(["sent_at", "subject_line", "recipient_email", "step_index"]);

export async function GET(req: NextRequest) {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const requestedSort = url.searchParams.get("sort") || "sent_at";
  const sort = SORT_COLUMNS.has(requestedSort) ? requestedSort : "sent_at";
  const ascending = url.searchParams.get("order") === "asc";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 250);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const db = getServiceSupabase();

  const [eventsResult, todayResult, loopsResult] = await Promise.all([
    db
      .from("drip_email_events")
      .select(
        "id,merchant_id,sequence_id,drip_run_id,step_index,recipient_email,subject_line,payload_text,payload_html,provider_message_id,sent_at",
      )
      .eq("tenant_id", tenantId)
      .order(sort, { ascending })
      .limit(limit),
    db
      .from("drip_email_events")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("sent_at", today.toISOString()),
    db
      .from("drip_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["scheduled", "sending"]),
  ]);

  if (eventsResult.error) {
    return NextResponse.json(
      { ok: false, error: "drip_tracker_lookup_failed", detail: eventsResult.error.message },
      { status: 500 },
    );
  }

  const events = eventsResult.data || [];
  const merchantIds = [...new Set(events.map((event) => event.merchant_id).filter(Boolean))];
  const sequenceIds = [...new Set(events.map((event) => event.sequence_id).filter(Boolean))];
  const [merchantsResult, sequencesResult] = await Promise.all([
    merchantIds.length
      ? db
          .from("tenant_records")
          .select("id,data")
          .eq("tenant_id", tenantId)
          .eq("entity_type", "lead")
          .in("id", merchantIds)
      : Promise.resolve({ data: [], error: null }),
    sequenceIds.length
      ? db
          .from("drip_sequences")
          .select("id,name")
          .eq("tenant_id", tenantId)
          .in("id", sequenceIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const merchantNames = new Map(
    (merchantsResult.data || []).map((row) => {
      const data = (row.data as Record<string, unknown>) || {};
      return [
        String(row.id),
        String(data.business_name || data.company || data.contact_name || data.email || row.id),
      ];
    }),
  );
  const sequenceNames = new Map(
    (sequencesResult.data || []).map((row) => [String(row.id), String(row.name)]),
  );

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    metrics: {
      total_sent_today: todayResult.count || 0,
      active_loops: loopsResult.count || 0,
      visible_events: events.length,
    },
    events: events.map((event) => ({
      ...event,
      merchant_name: merchantNames.get(String(event.merchant_id)) || "(unknown merchant)",
      sequence_name: sequenceNames.get(String(event.sequence_id)) || "(unknown sequence)",
    })),
  });
}
