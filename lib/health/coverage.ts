/**
 * lib/health/coverage.ts — discovers what EXISTS so nothing stays invisible.
 *
 * The root cause of the 2026-08-06 incident was not a missing check. It was a
 * hand-maintained watch list: 9 services were listed, the estate has ~20 cron
 * routes, 2 brands, 2 channels and a dozen integrations, and anything not on
 * the list was invisible. Nobody remembers to add things.
 *
 * So coverage is DERIVED, not declared:
 *   - crons      from vercel.json
 *   - brands     from the brand registry
 *   - sequences  from drip_sequences
 *
 * And the gap itself is reportable: anything discovered with no check attached
 * shows up in `uncovered`. Uncovered surface is a finding, not a silence.
 *
 * Pure except for the sequence lookup, so the discovery rules are testable.
 */

import { ALL_BRAND_KEYS, DRIP_BRAND_KEYS } from "@/lib/email/brands";
import type { TelegramLane } from "@/lib/notify/telegram";

export type Discovered = {
  crons: string[];
  brands: string[];
  checkIds: string[];
  /** Discovered surface with no check attached. This list should be empty, and
   *  when it is not, that is the alert. */
  uncovered: string[];
};

/**
 * Parse cron paths out of a vercel.json object. Takes the parsed config rather
 * than reading the file, so this is testable and works in any runtime.
 */
export function cronPathsFrom(vercelConfig: unknown): string[] {
  const cfg = vercelConfig as { crons?: Array<{ path?: string }> } | null;
  const crons = Array.isArray(cfg?.crons) ? cfg!.crons : [];
  return crons
    .map((c) => String(c?.path || "").split("?")[0].trim())
    .filter((p) => p.startsWith("/api/"))
    // Distinct: several crons hit the same route with different query strings.
    .filter((p, i, all) => all.indexOf(p) === i)
    .sort();
}

/** Canonical check id for a cron route, so discovery and checks agree. */
export function cronCheckId(path: string): string {
  return `cron${path.replace(/^\/api\/cron/, "").replace(/\//g, ".")}.ran`;
}

/**
 * What exists, what is checked, and what is neither.
 *
 * `knownCheckIds` is what the registry actually implements. Everything
 * discovered that has no corresponding id lands in `uncovered`.
 */
export function computeCoverage(args: {
  vercelConfig: unknown;
  knownCheckIds: string[];
  sequenceStages?: string[];
}): Discovered {
  const crons = cronPathsFrom(args.vercelConfig);
  const brands = [...ALL_BRAND_KEYS];
  const known = new Set(args.knownCheckIds);

  const uncovered: string[] = [];

  for (const path of crons) {
    // The health check route monitoring itself would be circular.
    if (path.includes("/health-check")) continue;
    if (!known.has(cronCheckId(path))) uncovered.push(cronCheckId(path));
  }
  for (const b of brands) {
    if (!known.has(`brand.${b}.sendable`)) uncovered.push(`brand.${b}.sendable`);
  }
  for (const stage of args.sequenceStages || []) {
    if (!known.has(`drips.${stage}.sent_24h`)) uncovered.push(`drips.${stage}.sent_24h`);
  }

  return { crons, brands, checkIds: [...known].sort(), uncovered: uncovered.sort() };
}

/** The two companies that operate surfaces on this platform. */
export type Company = "oasis" | "sunbiz";

/**
 * Which company's operations stop when a cron route stops.
 *
 * WHY. The coverage-gap report posted every uncovered route to sunbiz-ops, so
 * OASIS-only routes (reconcile-website-sales-payments,
 * dispatch-founder-meeting-reminders) were announced to SunBiz's operators, and
 * a gap in one of OASIS's own crons reached nobody at OASIS.
 *
 * Classified by who depends on the route today, checked against live data on
 * 2026-09-11: OASIS has no scheduled_sends, scheduled_calls, drip_runs or
 * dashboard bulk-email rows, so the tenant-generic engines behind those routes
 * serve SunBiz alone; plan_templates rows exist only for OASIS, so
 * materialize-plans is OASIS's.
 *
 * No default. A route missing from this map is reported to NEITHER company
 * rather than guessed at, and tests/health-lanes-per-company.test.ts fails until
 * it is classified. health-check is absent on purpose: coverage skips it,
 * because the health check monitoring itself would be circular.
 */
export const CRON_ROUTE_COMPANY: Readonly<Record<string, Company>> = {
  "/api/cron/materialize-plans": "oasis",
  "/api/cron/dispatch-founder-meeting-reminders": "oasis",
  "/api/cron/sms-reply-agent": "oasis",
  "/api/cron/reconcile-website-sales-payments": "oasis",

  "/api/cron/collect-outreach-intel": "sunbiz",
  "/api/cron/collect-cc-metrics": "sunbiz",
  "/api/cron/dispatch-scheduled-sends": "sunbiz",
  "/api/cron/enroll-drips": "sunbiz",
  "/api/cron/scan-lender-replies": "sunbiz",
  "/api/cron/dispatch-drips": "sunbiz",
  "/api/cron/reconcile-drip-telemetry": "sunbiz",
  "/api/cron/dispatch-scheduled-calls": "sunbiz",
  "/api/cron/sync-tt-inbox": "sunbiz",
  "/api/cron/operator-email-agent": "sunbiz",
  "/api/cron/scan-bounces": "sunbiz",
  "/api/cron/scan-funmate-replies": "sunbiz",
  "/api/cron/sweep-stale-sent-app": "sunbiz",
  "/api/cron/kixie-compliance-scan": "sunbiz",
  "/api/cron/enroll-accelerated": "sunbiz",
  "/api/cron/tps-enroll": "sunbiz",
  "/api/cron/tps-backlog-watch": "sunbiz",
  "/api/cron/renewal-thresholds": "sunbiz",
  "/api/cron/sync-sms-numbers": "sunbiz",
  "/api/cron/reconcile-sms": "sunbiz",
  "/api/cron/dispatch-bulk-email": "sunbiz",
};

/** Where each company's operators read their alerts. */
export const COMPANY_LANE: Readonly<Record<Company, TelegramLane>> = {
  oasis: "operator",
  sunbiz: "sunbiz-ops",
};

const COMPANY_NAME: Readonly<Record<Company, string>> = { oasis: "OASIS", sunbiz: "SunBiz" };

/** The company an uncovered surface belongs to, or null when nothing says. */
export function companyForCoverageId(id: string): Company | null {
  if (id.startsWith("brand.")) {
    const key = id.slice("brand.".length).replace(/\.sendable$/, "");
    if (key === "oasis") return "oasis";
    // SunBiz and Bluerise are SunBiz's two funding brands at one premises.
    if ((DRIP_BRAND_KEYS as readonly string[]).includes(key)) return "sunbiz";
    return null;
  }
  for (const [path, company] of Object.entries(CRON_ROUTE_COMPANY)) {
    if (cronCheckId(path) === id) return company;
  }
  // drips.<stage>.sent_24h names a stage and no tenant, so it cannot say whose
  // it is. It stays unowned rather than guessed.
  return null;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The coverage-gap alert, one message per company, each listing only that
 * company's surfaces. `unowned` is everything no company could be derived for:
 * returned for the caller to log, and sent to nobody.
 */
export function coverageGapMessages(
  uncovered: string[],
  crons: string[],
): {
  messages: Array<{ company: Company; lane: TelegramLane; ids: string[]; text: string }>;
  unowned: string[];
} {
  const own: Record<Company, string[]> = { oasis: [], sunbiz: [] };
  const unowned: string[] = [];
  for (const id of uncovered) {
    const company = companyForCoverageId(id);
    if (company) own[company].push(id);
    else unowned.push(id);
  }

  const messages: Array<{ company: Company; lane: TelegramLane; ids: string[]; text: string }> = [];
  for (const company of ["oasis", "sunbiz"] as const) {
    const ids = own[company];
    if (ids.length === 0) continue;
    const shown = ids.slice(0, 15);
    // Count only this company's routes: the other company's estate is not
    // this audience's business, not even as a number.
    const routes = crons.filter((p) => CRON_ROUTE_COMPANY[p] === company).length;
    messages.push({
      company,
      lane: COMPANY_LANE[company],
      ids,
      text:
        `⚪ <b>MONITORING GAP</b> — ${ids.length} surface(s) have no health check\n` +
        shown.map((u) => `· ${esc(u)}`).join("\n") +
        (ids.length > shown.length ? `\n…and ${ids.length - shown.length} more` : "") +
        `\n<i>${routes} ${COMPANY_NAME[company]} cron routes discovered from config/cron-registry.json</i>`,
    });
  }
  return { messages, unowned };
}
