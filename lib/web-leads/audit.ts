/**
 * lib/web-leads/audit.ts — the four honest states of "how does this site score".
 *
 * THE RULE THAT OUTRANKS THE FEATURE: a site we could not reach is NEVER given
 * a score. `leadgen_site_unreachable` (JARVIS migrations/004_site_unreachable.sql)
 * deliberately has no score column at all — a rep told "scores 0" about a site
 * that is perfectly fine is a false accusation made live on a sales call. So the
 * four states below are checked IN THIS ORDER, and `unreachable` is checked
 * BEFORE `not_scored`: a known failure to reach the site must never be reported
 * as "we haven't tried yet" (which would read as neutral) OR as a score (which
 * would read as a verdict). Both are wrong in different ways; only naming the
 * failure is honest.
 *
 *   1. no `website_url` on the lead              -> no_website
 *   2. a leadgen_site_unreachable row exists      -> unreachable (reason + last attempt, NEVER a number)
 *   3. no audit row, or its `profile` is null     -> not_scored  (never a zero)
 *   4. otherwise                                  -> scored, parsed from `profile`
 *
 * TENANT SCOPING IS THE AUTHORIZATION BOUNDARY, same as lib/web-leads/data.ts:
 * libSQL has no row-level security, so every read here pins WEBDEV_TENANT_ID
 * explicitly, matching data.ts's query style exactly.
 *
 * THE LEAD ID IS NOT THE BUSINESS ID (verified against source, not assumed).
 * `leadgen_site_audits` and `leadgen_site_unreachable` key on `business_id`
 * (JARVIS `leadgen_businesses.id`), but the id this module receives is a
 * `tenant_records.id` (the CRM row `fetchLead` reads). They are deliberately
 * different UUIDs, linked one way each direction: JARVIS's crm-sink.js writes
 * `leadgen_businesses.crm_record_id = <tenant_records.id>` on promotion, and
 * stamps the reverse pointer onto the lead itself as
 * `data.webdev_source_business_id = <leadgen_businesses.id>` (see
 * services/leadgen/lib/sinks/crm-sink.js, `toCrmData`). `fetchLead`/`WebLead`
 * do not surface that field (it is research plumbing, not a rep-facing fact),
 * so this module reads it directly off the same tenant_records row, under the
 * same tenant pin. A lead with no such pointer (e.g. one created outside the
 * leadgen pipeline) simply has no auditable business_id -- that falls through
 * to `not_scored`, which is the correct "we have never looked" answer, not an
 * error.
 *
 * MODEL VERSION is duplicated from JARVIS's services/leadgen/lib/scoring-run.js
 * (`export const MODEL_VERSION = 1`) rather than imported, because oasis and
 * JARVIS are separate deployments with no shared module graph -- the same
 * reason Task 2 ported remedies.js's copy instead of reading it at runtime.
 * Keep this in sync by hand if that constant ever bumps.
 *
 * fetchAudit() takes an already-resolved `WebLead`, not a viewer to re-fetch
 * one from: the route calls fetchLead(id, viewer) once for its own 404 check
 * (a lead outside the caller's scope must 404, never reveal a state), and
 * passing that same lead through here means authorization happens exactly
 * once per request instead of being re-derived a second time inside this
 * module.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID, type WebLead } from "./data";

/** Mirrors JARVIS services/leadgen/lib/scoring-run.js's MODEL_VERSION. */
const MODEL_VERSION = 1;

export type CheckResult = { code: string; label: string; points: number; has: boolean };

export type DimensionProfile = {
  key: string;
  label: string;
  score: number;
  weight: number;
  checks: CheckResult[];
  missing: string[];
};

/**
 * The shape JARVIS's `profileSite()` (services/leadgen/lib/quality-model.js)
 * actually returns, verified against source. The field is `composite`, NOT
 * `overall` -- an earlier draft of the plan behind this build said `overall`
 * and every downstream reference would have rendered `undefined`. (JARVIS's
 * scoreOne() also stores an `overall` alias alongside `composite` in the
 * persisted JSON for its own historical callers; this module deliberately
 * reads only `composite`, the name `profileSite` itself uses, so there is one
 * name for this number on the oasis side.)
 */
type StoredProfile = {
  composite: number;
  dimensions: DimensionProfile[];
  // results/overall may also be present on the stored JSON; not consumed here.
};

/**
 * Reference point for "how do we compare", measured from our own delivered
 * work via `node services/leadgen/benchmark.mjs --set` (JARVIS
 * services/leadgen/benchmark.json) rather than an opinion about what a good
 * site is -- every number a rep would quote is backed by a site the prospect
 * could open in the next tab. Synced by hand as of the timestamp below; there
 * is no live read path from oasis into JARVIS's benchmark.json, the same
 * reason Task 2 ported remedies.js's copy instead of reading it at runtime.
 *
 * NOTE ON WHICH NUMBER THIS IS: the plan for this build
 * (docs/superpowers/plans/2026-08-21-build-a-lead-detail.md) cites a
 * *portfolio* median of 44 across nine delivered sites (range 30-74) measured
 * 2026-08-20 as the reason this ships flag-gated. The snapshot below is the
 * single reference benchmark JARVIS actually persists to benchmark.json (our
 * flagship site, sunbizfunding.com) -- one site's score, not the nine-site
 * median. Both describe "how do our own sites score", but they are not the
 * same number and should not be quoted interchangeably; whichever build wires
 * the rendered comparison should reconcile this against a fresh
 * `benchmark.mjs --set` run rather than trusting either figure blindly.
 */
const OUR_BENCHMARK = {
  measuredAt: "2026-08-21T17:49:34.449Z",
  composite: 74,
  dimensions: [
    { key: "conversion", label: "Turning visitors into calls", score: 64 },
    { key: "trust", label: "Looking credible", score: 50 },
    { key: "design", label: "Looking current", score: 86 },
    { key: "mobile", label: "Working on a phone", score: 100 },
    { key: "content", label: "Explaining the service", score: 84 },
    { key: "performance", label: "Speed and security", score: 100 },
    { key: "discoverability", label: "Being found", score: 66 },
  ],
} as const;

export type BenchmarkComparison = {
  ourComposite: number;
  ourMeasuredAt: string;
  gaps: { key: string; label: string; theirs: number; ours: number; gap: number }[];
};

export type AuditResult =
  | { state: "no_website" }
  | { state: "not_scored" }
  | { state: "unreachable"; reason: string; lastAttemptedAt: string }
  | {
      state: "scored";
      url: string;
      measuredAt: string;
      composite: number;
      dimensions: DimensionProfile[];
      benchmark?: BenchmarkComparison;
    };

/**
 * Biggest-gap-first comparison against OUR_BENCHMARK. Only ever attached to a
 * `scored` result, and only when `WEBDEV_SHOW_BENCHMARK === "true"` -- see
 * fetchAudit(). Default off: our own sites do not yet win this comparison
 * (median 44 across nine delivered sites per the plan for this build), and a
 * prospect scoring 50 would beat most of our portfolio in front of a rep. The
 * comparison is one env var away once our own sites earn it.
 */
function compareToOurBenchmark(dimensions: DimensionProfile[]): BenchmarkComparison {
  const ourByKey = new Map<string, number>(OUR_BENCHMARK.dimensions.map((d) => [d.key, d.score]));
  const gaps = dimensions
    .map((d) => {
      const ours = ourByKey.get(d.key) ?? 0;
      return { key: d.key, label: d.label, theirs: d.score, ours, gap: ours - d.score };
    })
    .sort((a, b) => b.gap - a.gap);
  return { ourComposite: OUR_BENCHMARK.composite, ourMeasuredAt: OUR_BENCHMARK.measuredAt, gaps };
}

/**
 * The `leadgen_businesses.id` a lead was promoted from, or null if this lead
 * carries no such pointer (never audited by this pipeline, or created outside
 * it). See the module header for why this indirection exists.
 *
 * Takes the caller's already-resolved `id` rather than re-deriving anything:
 * the caller (fetchAudit) only reaches this after establishing via a prior
 * fetchLead() that this id is visible to the viewer, so this is a plain
 * tenant-pinned read of one more column on the SAME row, not a second
 * authorization check.
 */
async function businessIdForLead(id: string): Promise<string | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lead_data_read_failed: ${error.message}`);
  if (!data) return null;
  const row = data as { data: Record<string, unknown> };
  const businessId = row.data?.webdev_source_business_id;
  return typeof businessId === "string" && businessId.trim() ? businessId.trim() : null;
}

/** Charset-allowlist before a value reaches a PostgREST filter string. */
function safeFilterValue(v: string): string | null {
  return /^[A-Za-z0-9._:@-]{1,128}$/.test(v) ? v : null;
}

/**
 * `lead` must already be the result of a tenant-pinned, viewer-scoped
 * fetchLead(id, viewer) call for this SAME id -- the route resolves it once
 * for its own 404 check and passes it through here so authorization happens
 * exactly once per request, not twice.
 */
export async function fetchAudit(id: string, lead: WebLead): Promise<AuditResult> {
  if (!lead.websiteUrl) return { state: "no_website" };

  const businessId = await businessIdForLead(id);
  if (!businessId) return { state: "not_scored" };

  const bid = safeFilterValue(businessId);
  if (!bid) return { state: "not_scored" };

  const db = getServiceSupabase();

  // Rule 2, checked BEFORE rule 3: a known failure to reach the site must
  // never be reported as "not tried".
  const unreachable = await db
    .from("leadgen_site_unreachable")
    .select("reason,last_attempted_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", bid)
    .eq("audit_version", MODEL_VERSION)
    .maybeSingle();
  if (unreachable.error) throw new Error(`unreachable_read_failed: ${unreachable.error.message}`);
  if (unreachable.data) {
    const row = unreachable.data as { reason: string; last_attempted_at: string };
    return { state: "unreachable", reason: row.reason, lastAttemptedAt: row.last_attempted_at };
  }

  const audit = await db
    .from("leadgen_site_audits")
    .select("url,fetched_at,profile")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", bid)
    .eq("audit_version", MODEL_VERSION)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (audit.error) throw new Error(`audit_read_failed: ${audit.error.message}`);
  if (!audit.data) return { state: "not_scored" }; // Rule 3: no audit row.

  const row = audit.data as { url: string; fetched_at: string; profile: string | null };
  if (!row.profile) return { state: "not_scored" }; // Rule 4: scored before profiles existed.

  let profile: StoredProfile;
  try {
    profile = JSON.parse(row.profile) as StoredProfile;
  } catch {
    // A corrupt profile string is functionally the same as no profile: never
    // surface a broken panel, and never guess at a score from unparseable
    // data. See repository.js's own reasoning for why this column is JSON
    // text with an honest null rather than ever a literal "undefined".
    return { state: "not_scored" };
  }
  if (typeof profile.composite !== "number" || !Array.isArray(profile.dimensions)) {
    return { state: "not_scored" };
  }

  const result: AuditResult = {
    state: "scored",
    url: row.url,
    measuredAt: row.fetched_at,
    composite: profile.composite,
    dimensions: profile.dimensions,
  };
  // Default off. See compareToOurBenchmark's doc comment for why.
  if (process.env.WEBDEV_SHOW_BENCHMARK === "true") {
    result.benchmark = compareToOurBenchmark(profile.dimensions);
  }
  return result;
}

const auditModule = { fetchAudit };
export default auditModule;
