import "server-only";
import { buildDripHtml } from "@/lib/email/tracked-html";

type Db = ReturnType<typeof import("@/lib/supabase-server").getServiceSupabase>;

type Interaction = {
  id: string;
  tenant_id: string;
  lead_id: string;
  to_email: string | null;
  subject: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

/**
 * Reconstruct missing exact-payload telemetry from the canonical successful-send
 * ledger. The HTML is deterministic: the original plain body, interaction ID,
 * recipient and sequence email class are the same inputs used by the sender.
 */
export async function reconcileDripEmailTelemetry(db: Db, limit = 1000) {
  const interactionsResult = await db
    .from("lead_interactions")
    .select("id,tenant_id,lead_id,to_email,subject,content,metadata,created_at")
    .eq("channel", "email")
    .eq("direction", "outbound")
    .like("agent_source", "sequence:%")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 5000));
  if (interactionsResult.error) throw interactionsResult.error;

  const candidates = ((interactionsResult.data || []) as Interaction[]).filter((row) => {
    const meta = row.metadata || {};
    return (
      meta.provider === "submissions_gmail" &&
      typeof meta.sequence_id === "string" &&
      typeof meta.drip_run_id === "string" &&
      Number.isInteger(meta.step_index) &&
      Boolean(row.to_email && row.subject && row.content)
    );
  });
  if (!candidates.length) return { scanned: 0, inserted: 0, already_recorded: 0 };

  const runIds = candidates.map((row) => String(row.metadata!.drip_run_id));
  const existing = new Set<string>();
  for (let offset = 0; offset < runIds.length; offset += 200) {
    const result = await db
      .from("drip_email_events")
      .select("drip_run_id")
      .in("drip_run_id", runIds.slice(offset, offset + 200));
    if (result.error) throw result.error;
    for (const row of result.data || []) {
      if (row.drip_run_id) existing.add(String(row.drip_run_id));
    }
  }

  const missing = candidates.filter((row) => !existing.has(String(row.metadata!.drip_run_id)));
  const sequenceIds = [...new Set(missing.map((row) => String(row.metadata!.sequence_id)))];
  const sequenceClasses = new Map<string, string>();
  if (sequenceIds.length) {
    const result = await db.from("drip_sequences").select("id,email_class").in("id", sequenceIds);
    if (result.error) throw result.error;
    for (const row of result.data || []) {
      sequenceClasses.set(String(row.id), String(row.email_class || "commercial"));
    }
  }

  let inserted = 0;
  for (let offset = 0; offset < missing.length; offset += 100) {
    const rows = missing.slice(offset, offset + 100).map((row) => {
      const meta = row.metadata!;
      const sequenceId = String(meta.sequence_id);
      const recipient = row.to_email!;
      const text = row.content!;
      return {
        tenant_id: row.tenant_id,
        merchant_id: row.lead_id,
        sequence_id: sequenceId,
        drip_run_id: String(meta.drip_run_id),
        step_index: Number(meta.step_index),
        recipient_email: recipient,
        subject_line: row.subject!,
        payload_text: text,
        payload_html: buildDripHtml(text, {
          sendId: row.id,
          email: recipient,
          unsub: sequenceClasses.get(sequenceId) === "transactional" ? "none" : "footer",
          // Rebuild on the origin the SEND recorded, never today's config. This
          // reconciler scans historical interactions, so resolving the domain now
          // would rebuild aligned URLs for messages sent before the rollout, or
          // sent while the variable was unset and fell back — messages whose
          // links really were on the platform origin. Absence means platform,
          // which is correct for exactly those rows. This function's contract is
          // to reconstruct the payload EXACTLY; a plausible-looking wrong payload
          // is worse than none, because nothing downstream can tell it is wrong
          // (Codex review P2).
          trackingBase:
            typeof meta.tracking_base === "string" && meta.tracking_base
              ? meta.tracking_base
              : undefined,
        }),
        provider_message_id:
          typeof meta.rfc822_message_id === "string" ? meta.rfc822_message_id : null,
        sent_at: row.created_at,
      };
    });
    const result = await db.from("drip_email_events").upsert(rows, {
      onConflict: "tenant_id,drip_run_id",
      ignoreDuplicates: true,
    });
    if (result.error) throw result.error;
    inserted += rows.length;
  }

  return { scanned: candidates.length, inserted, already_recorded: existing.size };
}
