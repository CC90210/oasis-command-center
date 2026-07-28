import "server-only";
import { redactAll } from "@/lib/secret-redaction";

type DbLike = ReturnType<typeof import("@/lib/supabase-server").getServiceSupabase>;

export async function loadSunbizInboundContext(
  db: DbLike, tenantId: string, leadId: string | null, contactPhone: string,
): Promise<{ conversation: Record<string, unknown>; merchantContext: Record<string, unknown> }> {
  const phone10 = contactPhone.replace(/\D/g, "").slice(-10);
  if (!leadId && phone10.length !== 10) {
    throw new Error("invalid_contact_phone");
  }
  let interactions = db.from("lead_interactions")
    .select("direction,content,content_preview,sent_at,created_at")
    .eq("tenant_id", tenantId).eq("channel", "sms")
    .order("created_at", { ascending: false }).limit(12);
  interactions = leadId
    ? interactions.eq("lead_id", leadId)
    : interactions.or(`from_phone.ilike.%${phone10}%,to_phone.ilike.%${phone10}%`);
  const history = await interactions;
  if (history.error) throw new Error("conversation_context_failed");
  const messages = ((history.data || []) as Array<Record<string, unknown>>).reverse().map((row) => ({
    direction: row.direction,
    text: redactAll(String(row.content || row.content_preview || "")).slice(0, 1000),
    at: row.sent_at || row.created_at,
  }));

  const knownFacts: Record<string, unknown> = {};
  if (leadId) {
    const lead = await db.from("tenant_records").select("data")
      .eq("tenant_id", tenantId).eq("entity_type", "lead").eq("id", leadId).maybeSingle();
    if (lead.error) throw new Error("merchant_context_failed");
    const data = (lead.data?.data || {}) as Record<string, unknown>;
    for (const key of ["business_name", "contact_name", "monthly_revenue", "time_in_business",
      "funding_amount", "industry", "state", "stage"]) {
      if (data[key] != null) knownFacts[key] = redactAll(String(data[key])).slice(0, 300);
    }
  }
  return { conversation: { messages }, merchantContext: { known_facts: knownFacts } };
}
