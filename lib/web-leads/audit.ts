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

// ONE definition, in ./tenant, re-exported here so existing import sites keep
// working. It was briefly declared in both this file and scores.ts: both said
// 1, both were correct, and the next bump would have changed one of them --
// leaving the list selecting one audit version and the panel selecting another,
// which is precisely the disagreement this pair of modules exists to prevent.
// A duplicated constant that happens to agree today is not a shared constant.
// (Codex review, 2026-08-23.)
export { MODEL_VERSION } from "./tenant";
import { MODEL_VERSION } from "./tenant";
import { isParkedUrl, finalUrlFromSignals } from "./parked-domains";

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
export type StoredProfile = {
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
  // Model v2 measurement (benchmark.mjs --set under MODEL_VERSION 2).
  measuredAt: "2026-09-02T19:59:29.009Z",
  composite: 73,
  dimensions: [
    { key: "conversion", label: "Turning visitors into calls", score: 60 },
    { key: "trust", label: "Looking credible", score: 61 },
    { key: "design", label: "Looking current", score: 84 },
    { key: "mobile", label: "Working on a phone", score: 80 },
    { key: "content", label: "Explaining the service", score: 84 },
    { key: "performance", label: "Speed and security", score: 100 },
    { key: "discoverability", label: "Being found", score: 64 },
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
  /**
   * The domain is FOR SALE. Added 2026-08-25.
   *
   * Distinct from `unreachable`, and the distinction is the whole point: we
   * reached it perfectly and were served a domain broker's listing. Reporting
   * that as "we could not check this site" swaps one false statement for
   * another and discards the strongest opener a rep has -- their web address
   * has lapsed and anyone can buy it.
   *
   * Distinct from `scored` for a harder reason: it WAS scored, at 82, because a
   * parking page really is fast, HTTPS, mobile-friendly and full of CTAs. The
   * 49 checks worked exactly as designed on a page that has nothing to do with
   * the business.
   */
  | { state: "parked"; url: string; finalUrl: string; measuredAt: string }
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
export async function businessIdForLead(id: string): Promise<string | null> {
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
export function safeFilterValue(v: string): string | null {
  return /^[A-Za-z0-9._:@-]{1,128}$/.test(v) ? v : null;
}

/**
 * `leadgen_site_audits.profile` is stored as JSON TEXT (see repository.js's
 * saveAudit -- libSQL has no json type), but this repo's Turso adapter
 * (lib/turso-postgrest.ts's fromSql/rowOut) auto-decodes any string column
 * that LOOKS like JSON before the row ever reaches calling code. That means
 * the SAME column arrives as an already-parsed OBJECT when read through the
 * Turso backend (EMPIRE_DATA_BACKEND=turso_cloud, the live path -- see
 * data.ts's header comment) and as a raw STRING when read through a real
 * supabase-js client (the non-Turso fallback path), because supabase-js does
 * no such decoding. Code that assumes only one of those shapes is silently
 * wrong on the other backend: assuming a string here previously ran
 * JSON.parse() on an already-decoded object, which stringifies it to the
 * literal text "[object Object]", throws, and was swallowed by the
 * not-scored fallback -- so every real, correctly-scored lead rendered "Not
 * scored yet" on the live Turso path. Caught by an independent review
 * (2026-08-21), not by this module's own tests, because the test's fixture
 * fabricated the row directly and never went through the adapter.
 */
function safeParse(text: string): StoredProfile | null {
  try {
    return JSON.parse(text) as StoredProfile;
  } catch {
    return null;
  }
}

/**
 * Accepts a profile column value in either shape the adapter can hand back.
 * Exported so tests can prove both shapes are handled without standing up a
 * live DB client for fetchAudit() -- see tests/web-leads-audit.test.ts.
 */
export function coerceProfile(raw: unknown): StoredProfile | null {
  if (raw && typeof raw === "object") return raw as StoredProfile;
  if (typeof raw === "string") return safeParse(raw);
  return null;
}

/**
 * The RAW measured signals behind the newest audit for one business, or null.
 *
 * WHY A SEPARATE READ RATHER THAN ANOTHER COLUMN ON fetchAudit(): every lead
 * panel and every Call Mode card calls fetchAudit on open, and none of them
 * render a single signal. The signals blob is the crawler's whole observation
 * of a page -- fifty-odd fields -- and widening the hot path to carry it would
 * make every panel open pay for a section only the battle card shows. The
 * battle card is a full page a rep opens deliberately; one extra query there is
 * the right place for the cost.
 *
 * SAME ROW AS fetchAudit(), by construction: identical tenant / business /
 * version pin and identical `fetched_at desc limit 1` ordering. If those ever
 * diverge, the evidence section would quote a different crawl than the score
 * above it -- a rep reading "page weight 4.2MB" that belongs to last month's
 * version of the site.
 *
 * `signals` is JSON TEXT (JARVIS migrations/001_leadgen.sql) and therefore
 * arrives in BOTH shapes depending on the backend, exactly like `profile`: an
 * already-decoded object through the Turso adapter, a raw string through
 * supabase-js. See coerceProfile's doc comment for the outage that caused.
 */
export function coerceSignals(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchAuditSignals(businessId: string): Promise<Record<string, unknown> | null> {
  const bid = safeFilterValue(businessId);
  if (!bid) return null;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_site_audits")
    .select("signals")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", bid)
    .eq("audit_version", MODEL_VERSION)
    // Same predicate as the score read below: two writers share this
    // audit_version with incompatible signals shapes (score-sites vs the
    // contact-harvest worker), and an unpredicated "newest" here could hand
    // back a foreign blob while the score came from an older row -- the
    // measured evidence lines would then describe a different crawl than the
    // score they explain. Scored rows only, so both reads land on the same
    // measurement. (2026-09-01 integrity audit, finding 6.)
    .not("profile", "is", null)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`signals_read_failed: ${error.message}`);
  if (!data) return null;
  return coerceSignals((data as { signals: unknown }).signals);
}

/**
 * URL-ownership verification state for the business behind a lead, from
 * leadgen_businesses (JARVIS ownership-verify.js writes it; migration
 * 009_url_verification.sql). Until 2026-09-01 this NEVER reached the card --
 * a rep could read a whole battle card about a website the system had only
 * guessed belongs to this business. Absent row or absent column value reads
 * as "unknown", which the card states in words; it is the honest default for
 * the ~27k businesses verification has not covered yet.
 */
export type UrlVerification = {
  verdict: "verified" | "review" | "rejected" | "unknown";
  verifiedAt: string | null;
};

export async function fetchUrlVerification(businessId: string): Promise<UrlVerification> {
  const bid = safeFilterValue(businessId);
  if (!bid) return { verdict: "unknown", verifiedAt: null };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_businesses")
    .select("url_verdict,url_verified_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", bid)
    .maybeSingle();
  if (error) throw new Error(`url_verification_read_failed: ${error.message}`);
  const raw = (data as { url_verdict?: unknown; url_verified_at?: unknown } | null)?.url_verdict;
  const verdict =
    raw === "verified" || raw === "review" || raw === "rejected" ? raw : "unknown";
  const at = (data as { url_verified_at?: unknown } | null)?.url_verified_at;
  return { verdict, verifiedAt: typeof at === "string" ? at : null };
}

/**
 * The latest per-lead re-check request, if any -- the card shows its state
 * and polls while one is pending/running. Table written by the oasis recheck
 * endpoint and drained by JARVIS services/leadgen/recheck-worker.mjs.
 */
export type RecheckStatus = {
  status: "pending" | "running" | "done" | "failed";
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
};

export async function fetchRecheckStatus(leadId: string): Promise<RecheckStatus | null> {
  const lid = safeFilterValue(leadId);
  if (!lid) return null;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_recheck_requests")
    .select("status,requested_at,completed_at,error")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("lead_id", lid)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`recheck_read_failed: ${error.message}`);
  if (!data) return null;
  const row = data as { status: unknown; requested_at: string; completed_at: unknown; error: unknown };
  const status =
    row.status === "pending" || row.status === "running" || row.status === "done" || row.status === "failed"
      ? row.status
      : null;
  if (!status) return null;
  return {
    status,
    requestedAt: row.requested_at,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    error: typeof row.error === "string" ? row.error : null,
  };
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
  // never be reported as "not tried". PRECEDENCE BY TIME, not by table
  // (2026-09-01, per-lead re-check): an unreachable marker only wins over a
  // scored audit when the failed attempt is the NEWER fact. Without the
  // comparison, one stale unreachable row would mask every fresh score a
  // re-check writes -- the fix feature would be unable to fix anything.
  const unreachable = await db
    .from("leadgen_site_unreachable")
    .select("reason,last_attempted_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", bid)
    .eq("audit_version", MODEL_VERSION)
    .maybeSingle();
  if (unreachable.error) throw new Error(`unreachable_read_failed: ${unreachable.error.message}`);
  let unreachableRow: { reason: string; last_attempted_at: string } | null = null;
  if (unreachable.data) {
    unreachableRow = unreachable.data as { reason: string; last_attempted_at: string };
  }

  // TWO reads, because two WRITERS share this audit_version with incompatible
  // rows (2026-09-01 integrity audit, finding 6): score-sites stores scored
  // deep-signals rows; the contact-harvest worker stores profile-less rows
  // with a foreign signals shape. The newest row OVERALL answers "is the
  // domain parked / was anything measured at all"; the newest SCORED row
  // carries the quality measurement. Reading only the newest row let a newer
  // harvest row silently blank a lead's perfectly good score into
  // `not_scored`.
  const newest = await db
    .from("leadgen_site_audits")
    // `signals` joins the select so the parked check below reads the SAME row
    // it judges. Fetching it separately would let a re-crawl land in between
    // and score one row while judging another.
    .select("url,fetched_at,profile,signals")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", bid)
    .eq("audit_version", MODEL_VERSION)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (newest.error) throw new Error(`audit_read_failed: ${newest.error.message}`);
  if (!newest.data) {
    // No audit at all: an unreachable marker, if any, is the only fact.
    if (unreachableRow) {
      return { state: "unreachable", reason: unreachableRow.reason, lastAttemptedAt: unreachableRow.last_attempted_at };
    }
    return { state: "not_scored" }; // Rule 3: no audit row.
  }

  let row = newest.data as { url: string; fetched_at: string; profile: unknown; signals: unknown };

  // Unreachable wins only while it is the newest fact about this site.
  if (unreachableRow && Date.parse(unreachableRow.last_attempted_at) >= Date.parse(row.fetched_at)) {
    return { state: "unreachable", reason: unreachableRow.reason, lastAttemptedAt: unreachableRow.last_attempted_at };
  }

  // Parked is judged on the NEWEST row BEFORE any scored-row substitution: a
  // newer crawl that saw the domain redirect to a parking lot is the current
  // fact about this site, and swapping in an older scored row first would
  // resurface a score for a domain now known to be dead. (Codex review,
  // 2026-09-01.) The check runs again on the substituted row below, which is
  // harmless and preserves the original behaviour when no substitution
  // happened.
  {
    const newestFinal = finalUrlFromSignals(row.signals);
    if (isParkedUrl(newestFinal)) {
      return {
        state: "parked",
        url: row.url,
        finalUrl: newestFinal as string,
        measuredAt: row.fetched_at,
      };
    }
  }

  if (!row.profile) {
    const scored = await db
      .from("leadgen_site_audits")
      .select("url,fetched_at,profile,signals")
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("business_id", bid)
      .eq("audit_version", MODEL_VERSION)
      .not("profile", "is", null)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (scored.error) throw new Error(`audit_read_failed: ${scored.error.message}`);
    if (scored.data) {
      // The score shown is the newest actual quality measurement, stamped
      // with ITS OWN fetched_at -- never the harvest row's newer date worn by
      // an older measurement.
      row = scored.data as { url: string; fetched_at: string; profile: unknown; signals: unknown };
    }
  }

  // Rule 3b: THE DOMAIN IS FOR SALE, so there is no site to score.
  //
  // Checked BEFORE the profile, because a parked page has a perfectly good
  // profile -- that is the entire problem. All 53 in the corpus scored exactly
  // 82 and every one landed in the top tier, which is what put two of them in
  // front of a prospect as "best-scoring competitors" (2026-08-25).
  const finalUrl = finalUrlFromSignals(row.signals);
  if (isParkedUrl(finalUrl)) {
    return {
      state: "parked",
      url: row.url,
      finalUrl: finalUrl as string,
      measuredAt: row.fetched_at,
    };
  }

  if (!row.profile) return { state: "not_scored" }; // Rule 4: scored before profiles existed.

  const profile = coerceProfile(row.profile);
  if (!profile || typeof profile.composite !== "number" || !Array.isArray(profile.dimensions)) {
    // A missing, corrupt, or malformed profile is functionally the same as no
    // profile: never surface a broken panel, and never guess at a score from
    // data that doesn't match the shape profileSite() actually produces. See
    // repository.js's own reasoning for why this column is JSON text with an
    // honest null rather than ever a literal "undefined".
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
