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
import { isActiveMember } from "@/lib/team";
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
  tenantId: string,
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

  // An address typed straight into a rep field gets the same rule as an id:
  // drop it when this tenant knows it only as a deactivated teammate. One with
  // no profile here is left to the roster gate below. A failed check drops the
  // typed addresses rather than pre-check someone who may have left.
  if (repEmails.length > 0) {
    const typed = await db
      .from("user_profiles")
      .select("email, deactivated_at")
      .eq("tenant_id", tenantId);
    if (typed.error) {
      console.warn("[derive-agent-ccs] typed rep email check failed", { tenantId, error: typed.error.message });
      repEmails.length = 0;
    } else {
      const active = new Set<string>();
      const deactivated = new Set<string>();
      for (const p of (typed.data || []) as Array<{ email: string | null; deactivated_at: string | null }>) {
        const email = (p.email || "").trim().toLowerCase();
        if (email) (isActiveMember(p) ? active : deactivated).add(email);
      }
      const kept = repEmails.filter((email) => active.has(email) || !deactivated.has(email));
      repEmails.splice(0, repEmails.length, ...kept);
    }
  }

  // Resolve UUID-shaped fields to emails via THIS tenant's user_profiles. A
  // deactivated teammate keeps the deal (history) but is never a pre-checked
  // CC on new lender mail: the pre-checked list also picks the signer.
  if (idFields.length > 0) {
    const profiles = await db
      .from("user_profiles")
      .select("auth_user_id, email, deactivated_at")
      .eq("tenant_id", tenantId)
      .in("auth_user_id", idFields);
    for (const p of (profiles.data || []) as Array<{ email: string | null; deactivated_at: string | null }>) {
      if (!isActiveMember(p)) continue;
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

/**
 * The CC list for a NEW message on an existing lender thread, minus anyone this
 * tenant knows only as a deactivated teammate. A thread's cc_emails is frozen at
 * the original shop-out, so without this a rep deactivated since then is copied
 * on every reply and retry. Kept: an address with any active profile here, and
 * an address on no profile here (the lender's own CCs, an outside address).
 * Scoped to this tenant: being active in another workspace keeps nobody here.
 * Returns the input unchanged when nothing is dropped.
 *
 * Read-error rule: the addresses we cannot verify but know to be teammates —
 * the agents.config.json roster — are dropped, and every other address is kept,
 * so the lender still gets the message with its own CCs. A standing hiccup must
 * not stall a live deal, and it must not copy a rep who may have left either.
 */
export async function dropDeactivatedEmails(
  db: SupabaseClient,
  tenantId: string,
  emails: string[],
): Promise<string[]> {
  if (emails.length === 0) return emails;
  const keyOf = (email: string) => String(email).trim().toLowerCase();

  const profiles = await db
    .from("user_profiles")
    .select("email, deactivated_at")
    .eq("tenant_id", tenantId);
  if (profiles.error) {
    const roster = new Set(getAgents().map((a) => keyOf(a.email)));
    const kept = emails.filter((email) => !roster.has(keyOf(email)));
    console.warn("[derive-agent-ccs] cc teammate check failed", {
      tenantId,
      dropped: emails.filter((email) => roster.has(keyOf(email))),
      error: profiles.error.message,
    });
    return kept;
  }

  const active = new Set<string>();
  const deactivated = new Set<string>();
  for (const p of (profiles.data || []) as Array<{ email: string | null; deactivated_at: string | null }>) {
    const email = keyOf(p.email || "");
    if (email) (isActiveMember(p) ? active : deactivated).add(email);
  }
  const isRetired = (email: string) => deactivated.has(keyOf(email)) && !active.has(keyOf(email));
  const dropped = emails.filter(isRetired);
  if (dropped.length === 0) return emails;
  console.warn("[derive-agent-ccs] deactivated teammate dropped from cc", { tenantId, dropped });
  return emails.filter((email) => !isRetired(email));
}
