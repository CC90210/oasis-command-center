/**
 * agent-routing.ts — per-agent form routing for SunBiz intake.
 *
 * A shared interest form is published once; each agent (Jordan / Alex / Ezra)
 * shares a link carrying ?rep=<agent>. On submit we resolve that rep to the
 * agent's user_profiles.auth_user_id and stamp it on the new lead as
 * assigned_to — so the Opportunity Pipeline + drawer show the deal under that
 * agent's NAME (lib/assigned-names.ts already resolves assigned_to → name).
 *
 * We resolve against user_profiles (the authoritative owner of assigned_to),
 * NOT agents.config.json — the config roster is keyed for email-signing and
 * uses "Matt" where the tenant member is "Ezra". Matching tenant members by
 * name / email-local also means the member list IS the allowlist: a spoofed
 * ?rep only ever reassigns among real tenant members, never an outsider.
 *
 * Also mints the per-lead link to the FULL application form, stored on
 * lead.data.application_url so the Inquiry Welcomer drip's {{lead.application_url}}
 * substitution (sequence_runner _build_context spreads lead.data) resolves with
 * no Python-side HMAC key.
 */

import "server-only";
import { getTenantMembers } from "@/lib/team";
import { signFormLink } from "@/lib/form-links";
import { getServiceSupabase } from "@/lib/supabase-server";

export type RepAssignment = { auth_user_id: string; name: string };

/**
 * Resolve a ?rep=<key> to a tenant member. `key` matches the member's display
 * name / full name (case-insensitive) or their email local-part — so ?rep=jordan,
 * ?rep=alex, ?rep=ezra all resolve. Returns null for unknown reps (lead lands
 * unassigned, not crashed).
 */
export async function resolveRepAssignment(
  tenantId: string,
  repKey: string | undefined | null,
): Promise<RepAssignment | null> {
  if (!repKey || typeof repKey !== "string") return null;
  const key = repKey.trim().toLowerCase();
  if (!key) return null;
  const members = await getTenantMembers(tenantId).catch(() => []);
  for (const m of members) {
    if (!m.auth_user_id) continue;
    const name = (m.display_name || m.full_name || "").trim();
    const emailLocal = (m.email || "").trim().toLowerCase().split("@")[0];
    if (name.toLowerCase() === key || emailLocal === key) {
      return { auth_user_id: m.auth_user_id, name: name || key };
    }
  }
  return null;
}

/**
 * Smart matching: find an existing lead for this tenant by email or phone, so a
 * returning merchant who opens a fresh form link + re-enters their details
 * routes into their EXISTING file instead of spawning a duplicate lead. Email
 * is matched lowercased (new leads are stored lowercased); phone exact. Returns
 * the most-recent match, or null when nothing matches (caller creates fresh).
 */
export async function findExistingLead(
  tenantId: string,
  match: { email?: string | null; phone?: string | null; business?: string | null },
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const db = getServiceSupabase();

  // 1. Strong identity keys — email (lowercased) OR phone (exact). These
  //    uniquely identify a returning merchant no matter which of the three
  //    forms they filled, in any order (interest, full app, bank statements).
  const email = (match.email || "").trim().toLowerCase();
  const phone = (match.phone || "").trim();
  const ors: string[] = [];
  if (email) ors.push(`data->>email.eq.${email}`);
  if (phone) ors.push(`data->>phone.eq.${phone}`);
  if (ors.length > 0) {
    const q = await db
      .from("tenant_records")
      .select("id, data, created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .or(ors.join(","))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!q.error && q.data) {
      const row = q.data as { id: string; data: Record<string, unknown> | null };
      return { id: row.id, data: row.data || {} };
    }
  }

  // 2. Secondary key — company name (case-insensitive exact). Catches a
  //    returning merchant who used a different contact email/number on a
  //    later form. LIKE wildcards in the name are escaped so it stays an
  //    exact match, never a broad one.
  const business = (match.business || "").trim();
  if (business) {
    const safe = business.replace(/[%_\\]/g, "\\$&");
    const q = await db
      .from("tenant_records")
      .select("id, data, created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .ilike("data->>business_name", safe)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!q.error && q.data) {
      const row = q.data as { id: string; data: Record<string, unknown> | null };
      return { id: row.id, data: row.data || {} };
    }
  }

  return null;
}

/**
 * Mint an absolute, HMAC-signed URL to one of the tenant's enabled forms for a
 * specific lead. Returns null when no enabled form with that slug exists, or
 * when form-link signing is unconfigured (fail-closed) — callers leave the
 * link unset and degrade (skip the step / omit the link) rather than emit a
 * broken URL.
 */
export async function mintFormLinkBySlug(
  origin: string,
  tenantId: string,
  tenantSlug: string,
  leadId: string,
  slug: string,
): Promise<string | null> {
  const db = getServiceSupabase();
  const res = await db
    .from("forms")
    .select("id, slug")
    .eq("tenant_id", tenantId)
    .eq("slug", slug)
    .eq("enabled", true)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const form = res.data as { id: string; slug: string };
  const token = signFormLink({ tenant: tenantSlug, form_id: form.id, lead_id: leadId });
  if (!token) return null;
  return `${origin}/f/${tenantSlug}/${form.slug}/${token}`;
}

/**
 * Mint an absolute, HMAC-signed URL to the tenant's FULL application form for
 * one lead. Thin wrapper over mintFormLinkBySlug for the canonical
 * "full-application" slug — used by the form-submit route to stamp
 * lead.data.application_url.
 */
export async function mintFullApplicationLink(
  origin: string,
  tenantId: string,
  tenantSlug: string,
  leadId: string,
): Promise<string | null> {
  return mintFormLinkBySlug(origin, tenantId, tenantSlug, leadId, "full-application");
}
