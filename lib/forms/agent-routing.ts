/**
 * agent-routing.ts — per-agent form routing for SunBiz intake.
 *
 * A shared interest form is published once; each agent (Jordan / Alex / Matt)
 * shares a link carrying ?rep=<agent>. On submit we resolve that rep to the
 * agent's user_profiles.auth_user_id and stamp it on the new lead as
 * assigned_to — so the Opportunity Pipeline + drawer show the deal under that
 * agent's NAME (lib/assigned-names.ts already resolves assigned_to → name).
 *
 * We resolve against user_profiles (the authoritative owner of assigned_to),
 * NOT agents.config.json — the config roster is keyed for email-signing.
 * Matching tenant members by
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
import { publicFormOrigin } from "@/lib/forms/public-origin";

export type RepAssignment = { auth_user_id: string; name: string };

// Backward-compat: per-agent links shared before the 2026-06-23 Ezra→Matt rename
// carry ?rep=ezra. Alias the legacy key to the current member name so those
// links still route to the owner instead of landing unassigned.
const REP_ALIASES: Record<string, string> = { ezra: "matt" };

/**
 * Resolve a ?rep=<key> to a tenant member. `key` matches the member's display
 * name / full name (case-insensitive) or their email local-part — so ?rep=jordan,
 * ?rep=alex, ?rep=matt all resolve (legacy ?rep=ezra aliases to matt). Returns null for unknown reps (lead lands
 * unassigned, not crashed).
 */
export async function resolveRepAssignment(
  tenantId: string,
  repKey: string | undefined | null,
): Promise<RepAssignment | null> {
  if (!repKey || typeof repKey !== "string") return null;
  const raw = repKey.trim().toLowerCase();
  if (!raw) return null;
  const key = REP_ALIASES[raw] ?? raw;
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

/** More leads than this on one phone is not an identity key; see findExistingLead. */
const STRONG_KEY_SCAN = 25;

/** The company a lead names, lowercased: SunBiz stores `business_name`, OASIS `company`. */
function leadBusinessName(data: Record<string, unknown> | null): string {
  for (const key of ["business_name", "company"] as const) {
    const v = data?.[key];
    if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
  }
  return "";
}

/**
 * Smart matching: find an existing lead for this tenant by email or phone, so a
 * returning merchant who opens a fresh form link + re-enters their details
 * routes into their EXISTING file instead of spawning a duplicate lead. Email
 * is matched lowercased (new leads are stored lowercased); phone exact. Returns
 * the most-recent match, or null when nothing matches (caller creates fresh).
 *
 * `business`, when given, does two jobs: it refuses a PHONE match on a lead
 * that names a different business, and (unless `matchOnBusinessName: false`)
 * it is the step-2 fallback key. Quick-add and the Live Subs approval pass
 * `false`: they must never merge on a name alone.
 */
export async function findExistingLead(
  tenantId: string,
  match: { email?: string | null; phone?: string | null; business?: string | null },
  opts: { matchOnBusinessName?: boolean } = {},
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const db = getServiceSupabase();

  // 1. Strong identity keys — email (lowercased) OR phone (exact). These
  //    uniquely identify a returning merchant no matter which of the three
  //    forms they filled, in any order (interest, full app, bank statements).
  //
  //    Each key is BOUND with .eq(), never spliced into an .or() string. The
  //    .or() string is a grammar and the Turso adapter types its literals: an
  //    all-digit phone became the INTEGER 4165550199, which never equals the
  //    TEXT a lead stores, so from the Turso move until this change a phone
  //    matched nothing unless it happened to contain punctuation. A comma in
  //    a typed phone ("..., ext 2") also split the grammar and threw. A bound
  //    value is compared as the text it is, on Turso and on PostgREST alike.
  //    Both lookups run and the globally newest wins: the same "most recent
  //    match" rule the single OR query had, and the one step 2 uses below.
  //
  //    A PHONE match is refused when the caller names a business and the lead
  //    names a different one. An owner's cell is shared by every business they
  //    own, and merging a second business's submission into the first one's
  //    lead overwrites its name and contact and moves its deal. Refusing
  //    leaves the pre-fix outcome (no phone match), never a worse one.
  const email = (match.email || "").trim().toLowerCase();
  const phone = (match.phone || "").trim();
  const business = (match.business || "").trim();
  const strong: Array<{ id: string; data: Record<string, unknown> | null; created_at: string | null }> = [];
  for (const [field, value] of [["email", email], ["phone", phone]] as const) {
    if (!value) continue;
    // Newest first, and more than one row: when the newest lead on a phone is
    // a DIFFERENT business, an older lead on the same phone may still be this
    // one. Bounded: the most leads on one phone in production is 12
    // (oasis-webdev) and 3 (SunBiz), measured 2026-09-11.
    const q = await db
      .from("tenant_records")
      .select("id, data, created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .eq(`data->>${field}`, value)
      .order("created_at", { ascending: false })
      .limit(STRONG_KEY_SCAN);
    if (q.error || !Array.isArray(q.data)) continue;
    const rows = q.data as Array<{ id: string; data: Record<string, unknown> | null; created_at: string | null }>;
    const row = rows.find((r) => {
      if (field !== "phone" || !business) return true;
      const theirs = leadBusinessName(r.data);
      return !theirs || theirs === business.toLowerCase();
    });
    if (row) strong.push(row);
  }
  if (strong.length > 0) {
    strong.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    return { id: strong[0].id, data: strong[0].data || {} };
  }

  // 2. Secondary key — company name (case-insensitive exact). Catches a
  //    returning merchant who used a different contact email/number on a
  //    later form. LIKE wildcards in the name are escaped so it stays an
  //    exact match, never a broad one. Skipped when the caller asked for
  //    strong keys only.
  if (business && opts.matchOnBusinessName !== false) {
    const safe = business.replace(/[%_\\]/g, "\\$&");
    // BOTH SPELLINGS, because the estate genuinely contains both. SunBiz leads
    // store the company under `business_name`; OASIS leads store it under
    // `company` (its lead entity declares that field, not the other one).
    // Matching only business_name meant a returning OASIS merchant with a new
    // email always looked brand new — a duplicate lead, and the original
    // agent's attribution quietly lost with it.
    // BOTH LOOKUPS RUN, THEN THE GLOBALLY NEWEST WINS.
    //
    // Returning from inside the loop looked equivalent and was not: each query
    // orders only its OWN results. With an older `business_name` lead and a
    // newer `company` lead for the same business, the loop returned the older
    // one purely because business_name is checked first — and forms/submit then
    // merges the submission into the wrong lead, taking the newer lead's
    // attribution with it. "Most recent match" has to mean most recent across
    // both spellings, not most recent within whichever ran first.
    const candidates: Array<{ id: string; data: Record<string, unknown> | null; created_at: string | null }> = [];
    for (const field of ["business_name", "company"] as const) {
      const q = await db
        .from("tenant_records")
        .select("id, data, created_at")
        .eq("tenant_id", tenantId)
        .eq("entity_type", "lead")
        .ilike(`data->>${field}`, safe)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!q.error && q.data) {
        candidates.push(q.data as { id: string; data: Record<string, unknown> | null; created_at: string | null });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
      const row = candidates[0];
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
  const publicOrigin = publicFormOrigin({ tenantSlug, requestOrigin: origin });
  return `${publicOrigin}/f/${tenantSlug}/${form.slug}/${token}`;
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
