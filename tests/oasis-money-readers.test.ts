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
assert.match(founderToday, /showFinancials\s*\?\s*withDeadline\(loadOasisMoney\(tenantId, "today"\), TODAY_READ_DEADLINE_MS, "money"\)\s*:\s*Promise\.resolve\(null\)/);
assert.doesNotMatch(founderToday, /mrr_current_usd|mrrSnapshot|mrrHistory/);

const analytics = read("app/analytics/page.tsx");
// The gate is app/analytics/mrr-state.ts: "oasis" (the only state that reads
// money) is the same capability Today gates on, after a failed workspace
// lookup has been ruled out.
const mrrState = read("app/analytics/mrr-state.ts");
assert.match(
  mrrState,
  /if \(!surface\.ok \|\| surface\.degraded\) return "unconfirmed";\s*if \(surface\.capabilities\.canSeeCompanyFinancials\) return "oasis";/,
  "/analytics must gate OASIS money on the same capability as Today",
);
assert.match(analytics, /const mrrState = analyticsMrrState\(surface\);/);
assert.match(analytics, /mrrState === "oasis" \? loadOasisMoney\(tenantId, "analytics"\) : Promise\.resolve\(null\)/);
// 2026-09-29: no workspace reads the typed profile MRR on /analytics any more.
// It used to be the non-OASIS branch, with a $5,000 target invented when none
// was set and a synthetic decline curve when no history existed; that branch
// now says "Not connected", and the readers are gone from lib/queries.ts.
assert.doesNotMatch(analytics, /mrrSnapshot|mrrHistory|mrr_current_usd|mrr_target_usd|MRRProgressChart/, "/analytics must not read or chart the typed profile MRR");
// 2026-09-30: the stat is "MRR (Stripe)", and its hint says when the books last heard from Stripe.
assert.match(analytics, /<Stat label="MRR \(Stripe\)" value=\{MRR_COPY\[noMoney\]\.value\}/, "a workspace without live Stripe MRR gets words, never a number");
assert.doesNotMatch(analytics, /`live Stripe/, "the MRR hint is a sync time, never a bare 'live Stripe'");
assert.match(mrrState, /not_connected: \{\s*value: "Not connected",/, "a confirmed non-OASIS workspace says Not connected");
const queries = read("lib/queries.ts");
assert.doesNotMatch(queries, /export async function mrr(Snapshot|History)\(/, "the fake-MRR readers must stay deleted");
assert.doesNotMatch(queries, /\|\| 5000|current \* 0\.005/, "no invented MRR target or synthetic curve in lib/queries.ts");

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
