/**
 * smoke-restricted-states.ts — can a merchant in a RESTRICTED state still get funded?
 *
 * WHY THIS EXISTS
 * `restricted_states` is a per-lender list of states a funder will not lend in.
 * Since the 2026-05-25 product meeting it is a SEVERITY FLAG, not a hard block:
 * a merchant in a restricted state must still be scored, still be matched to the
 * lenders who DO fund their state, and only the refusing lenders get flagged
 * high_risk. Two ways that can silently go wrong, and both look identical from
 * the outside:
 *
 *   1. The gate does not fire  -> the merchant is shopped to a lender who will
 *      never fund them, wasting a submission and the lender relationship.
 *   2. The gate over-fires     -> the merchant is flagged against lenders who
 *      would have funded them, and a fundable deal quietly dies.
 *
 * Neither raises an error. Both need to be measured against the REAL catalog,
 * because the restricted lists are operator-maintained data, not code.
 *
 * This runs the REAL scoreLenderMatch over the REAL lender records for every
 * restricted state plus an unrestricted control. Read-only.
 *
 *   node --import tsx scripts/smoke-restricted-states.ts
 */

import {
  scoreLenderMatch,
  complianceProfileInputs,
  type LenderProfile,
  type ApplicationProfile,
} from "../lib/lenders/match-fitness.ts";

const SUNBIZ_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

function credential(): { token: string; base: string } {
  const token = process.env.APEX_PG_BRIDGE_TOKEN || process.env.TT_PG_BRIDGE_TOKEN || "";
  const base = (process.env.TT_PG_BRIDGE_URL || "https://oasisai.work/api/pg").replace(/\/$/, "");
  return { token, base };
}

async function loadLenders(): Promise<{ id: string; name: string; profile: LenderProfile }[]> {
  const { token, base } = credential();
  if (!token) {
    // BLOCKED, not failed: a human must supply the credential. Exiting 0 with a
    // reason beats a red run that looks like the gate is broken.
    console.log(JSON.stringify({ blocked: true, reason: "no pg bridge token in env" }));
    process.exit(0);
  }
  const res = await fetch(
    `${base}/rest/v1/tenant_records?tenant_id=eq.${SUNBIZ_TENANT_ID}&entity_type=eq.lender&select=id,data&limit=200`,
    { headers: { Authorization: `Bearer ${token}`, apikey: token, Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`lender catalog read failed: http_${res.status}`);
  const rows = (await res.json()) as { id: string; data: unknown }[];
  return rows.map((r) => {
    const d = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
    // MIRROR lib/lenders/shop-out.ts EXACTLY. Spreading the raw record instead
    // would test a shape production never produces -- and it also crashes:
    // scoreLenderMatch guards max_funded_amount with `!== undefined`, which is
    // TRUE for null, so `50000 > null` coerces to `50000 > 0` and the branch
    // calls null.toLocaleString(). 9 of the 47 live lenders carry null there.
    // Both production loaders normalise null -> undefined, which is why this is
    // latent rather than live; see the audit note in the JARVIS session log.
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    return {
      id: r.id,
      name: String(d.name ?? d.lender_name ?? r.id.slice(0, 8)),
      profile: {
        id: r.id,
        name: String(d.name ?? "(unnamed)"),
        product_types: d.product_types as LenderProfile["product_types"],
        min_monthly_revenue: num(d.min_monthly_revenue),
        max_funded_amount: num(d.max_funded_amount),
        min_time_in_business_months: num(d.min_time_in_business_months),
        fico_floor: num(d.fico_floor),
        sla_response_days: num(d.sla_response_days),
        restricted_states: Array.isArray(d.restricted_states)
          ? (d.restricted_states as unknown[])
              .filter((s): s is string => typeof s === "string" && s.trim().length === 2)
              .map((s) => s.toUpperCase())
          : undefined,
        restricted_industries: Array.isArray(d.restricted_industries)
          ? (d.restricted_industries as unknown[])
              .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
              .map((s) => s.trim().toLowerCase())
          : undefined,
      } as LenderProfile,
    };
  });
}

/** A merchant good enough that only the state can be the reason to refuse. */
function merchantIn(state: string): ApplicationProfile {
  return {
    id: `smoke-${state}`,
    monthly_revenue: 90_000,
    requested_amount: 50_000,
    time_in_business_months: 48,
    fico: 700,
    positions: 1,
    ...complianceProfileInputs({ business_state: state, industry: "retail" }),
  } as ApplicationProfile;
}

const RESTRICTED = ["TX", "UT", "CA", "VA", "NY", "PR"];
const CONTROL = ["FL", "OH"]; // no lender in the catalog restricts these

const lenders = await loadLenders();
const restrictsState = (l: LenderProfile, s: string) =>
  Array.isArray(l.restricted_states) &&
  l.restricted_states.map((x) => String(x).trim().toUpperCase()).includes(s);

let failures = 0;
const rows: string[] = [];

for (const state of [...RESTRICTED, ...CONTROL]) {
  const app = merchantIn(state);
  const expectFlagged = lenders.filter((l) => restrictsState(l.profile, state)).map((l) => l.name);

  const flagged: string[] = [];
  const wronglyFlagged: string[] = [];
  let viable = 0;

  for (const l of lenders) {
    const score = scoreLenderMatch(l.profile, app);
    const hit = score.warnings.some((w) => w.code === "restricted_state" && w.severity === "high_risk");
    if (hit) flagged.push(l.name);
    if (hit && !restrictsState(l.profile, state)) wronglyFlagged.push(l.name);
    if (!score.warnings.some((w) => w.severity === "high_risk")) viable += 1;
  }

  const missed = expectFlagged.filter((n) => !flagged.includes(n));
  const ok = missed.length === 0 && wronglyFlagged.length === 0 && viable > 0;
  if (!ok) failures += 1;

  rows.push(
    `${ok ? "PASS" : "FAIL"}  ${state.padEnd(3)}  ` +
    `expected_flagged=${expectFlagged.length} actual=${flagged.length} ` +
    `missed=${missed.length} over_flagged=${wronglyFlagged.length} ` +
    `viable_lenders=${viable}/${lenders.length}` +
    (missed.length ? `\n        MISSED (gate did not fire): ${missed.join(", ")}` : "") +
    (wronglyFlagged.length ? `\n        OVER-FLAGGED (fundable deal killed): ${wronglyFlagged.join(", ")}` : "") +
    (viable === 0 ? `\n        NO VIABLE LENDERS — a merchant here has nowhere to go` : ""),
  );
}

console.log(`restricted-state smoke — ${lenders.length} live lenders\n`);
for (const r of rows) console.log(r);
console.log(`\n${failures === 0 ? "ALL STATES PASS" : `${failures} STATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
