/**
 * derive-agent-ccs.ts — Adon spec section 2.2 (2026-06-10).
 *
 * Inspect the application's rep fields (assigned_rep_email,
 * assigned_rep_id, owner_id, etc.), resolve any UUID-shaped fields to
 * emails via user_profiles, then intersect against agents.config.json.
 * Returns the derived DerivedAgentEntry list — the operator's
 * pre-checked checkboxes.
 *
 * Was duplicated between the run route + the panel page; extracted
 * here so the rep-field universe (which columns we look at) and the
 * UUID lookup pattern stay in sync.
 *
 * DB-touching (queries user_profiles) — server-only.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAgents } from "@/lib/config/agents";
import type { DerivedAgentEntry } from "@/components/shop-out/derived-cc-list";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Field names we scan on application.data when deriving the rep CC list.
 * Adon spec section 2.2 explicitly mentions assigned_rep_email +
 * assigned_rep_id + owner_id + assignee_id; we widen to catch "rep",
 * "agent", "assigned", "owner" too so an operator-renamed schema
 * still resolves correctly (intersection against agents.config.json
 * gates anything outside the roster anyway).
 */
const REP_FIELDS = [
  "assigned_rep_email",
  "assigned_rep_id",
  "owner_id",
  "assignee_id",
  "rep",
  "agent",
  "assigned",
  "owner",
] as const;

export async function deriveAgentCcs(
  db: SupabaseClient,
  appData: Record<string, unknown>,
): Promise<DerivedAgentEntry[]> {
  const repEmails: string[] = [];
  const idFields: string[] = [];

  for (const fieldName of REP_FIELDS) {
    const v = appData[fieldName];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed.includes("@")) {
      repEmails.push(trimmed.toLowerCase());
    } else if (UUID_RE.test(trimmed)) {
      idFields.push(trimmed);
    }
  }

  // Resolve UUID-shaped fields to emails via user_profiles.
  if (idFields.length > 0) {
    const profiles = await db
      .from("user_profiles")
      .select("auth_user_id, email")
      .in("auth_user_id", idFields);
    for (const p of (profiles.data || []) as Array<{ email: string | null }>) {
      if (p.email) repEmails.push(p.email.toLowerCase().trim());
    }
  }

  // Intersect against the roster — anyone not in agents.config.json is
  // excluded (Adon spec 2.2: "Anyone not in the config (e.g., processors,
  // admins) is excluded").
  const roster = getAgents();
  const agentByEmail = new Map(
    roster.map((a) => [a.email.toLowerCase().trim(), a]),
  );

  const derived: DerivedAgentEntry[] = [];
  const seen = new Set<string>();
  for (const email of repEmails) {
    if (seen.has(email)) continue;
    const agent = agentByEmail.get(email);
    if (agent) {
      derived.push({ key: agent.key, name: agent.name, email: agent.email });
      seen.add(email);
    }
  }
  return derived;
}
