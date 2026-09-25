/**
 * OASIS money has ONE reader (2026-09-24).
 *
 * Today read $6,263 — a hand-typed user_profiles.mrr_current_usd — while Stripe
 * read CA$100. The fix made live Stripe + the Finances ledger the only source,
 * behind lib/goals/oasis-money.ts. This pins the other surfaces that used to
 * assemble the number themselves, so a second copy cannot quietly come back:
 *
 *   - /analytics reads loadOasisMoney only behind canSeeCompanyFinancials;
 *   - the in-app agent's mrr_today withholds company money from a rep and
 *     reads the loader for a founder;
 *   - the snapshot cron never writes a profile number for an OASIS workspace;
 *   - none of them reads the retired profile MRR columns on the OASIS path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

const loader = read("lib/goals/oasis-money.ts");
assert.doesNotMatch(loader, /mrr_current_usd|mrr_target_usd/, "the OASIS money loader must not read the retired profile MRR");
assert.match(loader, /stripeMrr\(\)/, "Net MRR must come from live Stripe");
assert.match(loader, /revenueCollected\(range\)/, "goal progress must be money collected in the goal period");
// Before a founder pins OASIS's Stripe account nothing syncs, so fin_subscriptions
// is empty. That must read as "not connected", never as a confident CA$0.
assert.match(loader, /mrr: pinned === true \? mrr : null,/, "an unconnected Stripe account must not render as $0 MRR");

const founderToday = read("components/today/FounderToday.tsx");
assert.match(founderToday, /showFinancials \? await loadOasisMoney\(tenantId, "today"\) : null/);
assert.doesNotMatch(founderToday, /mrr_current_usd|mrrSnapshot|mrrHistory/);

const analytics = read("app/analytics/page.tsx");
assert.match(
  analytics,
  /const oasisMoney = surface\.ok && surface\.capabilities\.canSeeCompanyFinancials;/,
  "/analytics must gate OASIS money on the same capability as Today",
);
assert.match(analytics, /oasisMoney \? loadOasisMoney\(tenantId, "analytics"\) : Promise\.resolve\(null\)/);
assert.match(
  analytics,
  /oasisMoney\s*\?\s*Promise\.resolve\(null\)\s*:\s*safe\("analytics\.mrr_snapshot"/,
  "an OASIS workspace must not also read the profile MRR snapshot",
);

const tools = read("lib/agent-tools.ts");
const mrrTool = tools.slice(tools.indexOf("async mrr_today("), tools.indexOf("async today_plan("));
assert.ok(mrrTool.length > 0, "mrr_today not found");
const oasisGate = mrrTool.indexOf("isOasisSurfaceTenant(await tenantSlugFor(ctx.tenantId))");
const repWithheld = mrrTool.indexOf("if (!ctx.isAdmin) return { withheld:");
const loaderCall = mrrTool.indexOf("loadOasisMoney(ctx.tenantId");
const profileRead = mrrTool.indexOf("mrr_current_usd");
assert.ok(oasisGate >= 0 && repWithheld > oasisGate && loaderCall > repWithheld, "mrr_today: OASIS gate → rep withheld → loader, in that order");
assert.ok(profileRead > loaderCall, "the profile MRR read is only the non-OASIS fallback, after the OASIS branch returned");

const snapshot = read("app/api/cron/snapshot-mrr/route.ts");
assert.match(
  snapshot,
  /if \(isOasisSurfaceTenant\(await tenantSlugFor\(r\.tenant_id\)\)\) \{\s*skippedOasis\.push\(r\.tenant_id\);\s*continue;/,
  "the MRR snapshot cron must skip OASIS workspaces before building a profile row",
);

console.log("oasis-money-readers: OK — one loader, gated on Today, Analytics, the agent tool and the snapshot cron");
