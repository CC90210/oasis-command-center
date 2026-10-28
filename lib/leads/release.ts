/**
 * lib/leads/release.ts — clear a lead's owner.
 *
 * Moved out of lib/web-leads/claim-ops.ts when the Prospects surface was
 * retired (2026-10-28). Claiming from the pool went with Prospects; releasing
 * stayed, because deactivating a rep (lib/team-activation.ts) still clears the
 * owner of their unworked prospects. The ownership rules are the pure ones in
 * ./claim.
 *
 * EVERY STATEMENT PINS THE TENANT. libSQL has no row-level security, so
 * WEBDEV_TENANT_ID is on every read and every write.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { factsFrom, isInBookOf, releasePatch, ACTIVE_PROSPECT_CLAIM_STAGES } from "./claim";

/**
 * Clear the owner of these leads.
 *
 * A rep may release only their OWN leads; an admin may release anyone's. The
 * check is here rather than in the route because it is a property of the
 * operation, not of the HTTP layer -- and because a release that silently
 * skipped rows the caller did not own would report success for work it did not
 * do.
 */
export async function releaseLeads(
  userId: string,
  isAdmin: boolean,
  leadIds: string[],
  trackRelease = true,
): Promise<{ released: string[]; refused: string[]; trackingFailed: string[] }> {
  if (leadIds.length === 0) return { released: [], refused: [], trackingFailed: [] };
  const db = getServiceSupabase();

  const { data, error } = await db
    .from("tenant_records")
    .select("id,data,updated_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .in("id", leadIds);
  if (error) throw new Error(`release_read_failed: ${error.message}`);

  const rows = (data || []) as { id: string; data: Record<string, unknown>; updated_at: string }[];
  const nowIso = new Date().toISOString();
  const released: string[] = [];
  const refused: string[] = [];

  const allowed = rows.filter((r) => {
    const facts = factsFrom(r.data || {});
    // A manual release is a prospecting action, not a lifecycle repair tool.
    // Missing stages remain releasable for legacy pool rows, but founder
    // handoff, paid, lost, and delivery records keep their durable owner.
    const stage = facts.stage?.trim().toLowerCase() || "";
    if (stage && !ACTIVE_PROSPECT_CLAIM_STAGES.has(stage)) return false;
    if (isAdmin) return Boolean(facts.assignedTo);
    return isInBookOf(facts, userId);
  });
  for (const r of rows) if (!allowed.includes(r)) refused.push(r.id);

  const CHUNK = 12;
  for (let i = 0; i < allowed.length; i += CHUNK) {
    const chunk = allowed.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((r) => {
        const prevOwner = factsFrom(r.data || {}).assignedTo;
        return db
          .from("tenant_records")
          .update({ data: { ...(r.data || {}), ...releasePatch() }, updated_at: nowIso })
          .eq("id", r.id)
          .eq("tenant_id", WEBDEV_TENANT_ID)
          .eq("entity_type", "lead")
          // A compare-and-swap on the owner we observed. An unconditional
          // release writes back the snapshot read moments ago: if another rep
          // took the lead in between, that write both restores the stale data
          // AND clears the new owner. Conditioning on the observed owner means
          // a release can only ever release what we still hold.
          // (Codex review, 2026-08-23.)
          .eq("data->>assigned_to", prevOwner as string)
          // Preserve any concurrent contact/context correction too. Owner can
          // remain unchanged while another request fixes the website or note;
          // replacing that newer JSON with this older snapshot would lose it.
          .eq("updated_at", r.updated_at)
          .select("id");
      }),
    );
    results.forEach((res, idx) => {
      const id = chunk[idx].id;
      if (res.status === "fulfilled" && !res.value.error && (res.value.data as unknown[] | null)?.length === 1) {
        released.push(id);
      } else {
        refused.push(id);
      }
    });
  }

  let trackingFailed: string[] = [];
  if (trackRelease && released.length > 0) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const interactions = released.map((id) => {
      const previous = factsFrom(byId.get(id)?.data || {});
      const content = "Lead released to the shared prospect pool.";
      return {
        tenant_id: WEBDEV_TENANT_ID,
        lead_id: id,
        type: "lead_reassigned",
        channel: "system",
        direction: "internal",
        // The stored source name is history; reports and tests key on it.
        agent_source: "web_leads_release",
        actor_user_id: userId,
        subject: "Lead released",
        content,
        content_preview: content,
        created_at: nowIso,
        metadata: {
          action: "release",
          from_assigned_to: previous.assignedTo,
          assigned_to: null,
          from_stage: previous.stage,
        },
      };
    });
    const tracking = await db.from("lead_interactions").insert(interactions);
    if (tracking.error) {
      console.error("[leads.release] ownership cleared but interaction tracking failed", {
        leadIds: released,
        userId,
        error: tracking.error.message,
      });
      trackingFailed = [...released];
    }
  }

  return { released, refused, trackingFailed };
}
