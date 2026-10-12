/**
 * V2 router routing (HANDOVER 2026-10-12 section 4): per-answer routing
 * rules stored as data on the form itself (migration bravo__220,
 * forms.routing), parsed and evaluated against the SAME merged-answers
 * context show_if uses, then resolved to a real, safe destination.
 *
 * Pins:
 *   - lib/forms/routing.ts: strict parsing (rejects an absolute URL, an
 *     empty when_any, an unknown key), first-match-wins evaluation;
 *   - lib/forms/routing-destination.ts: a rule naming a disabled form,
 *     another tenant's form, or nothing a rule matched at all, ALWAYS falls
 *     through — to the next rule, then the community route, then null (the
 *     form's own ordinary behavior) — and the destination is ALWAYS a
 *     relative path, never absolute;
 *   - OASIS's actual default rules (content/offers/oasis/vsl-routing.json)
 *     against the exact scenarios in HANDOVER's table;
 *   - lib/forms/router-cat-preselect.ts: ?cat=p1..p4, unknown cat ignored.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-router-routing.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseFormRouting,
  firstMatchingGo,
  RoutingDefinitionError,
  COMMUNITY_LINK_GO,
  type FormRoutingRule,
} from "../lib/forms/routing";
import { resolveRouterDestination } from "../lib/forms/routing-destination";
import { routerPathForCatParam, routerPrefillForCat } from "../lib/forms/router-cat-preselect";

// ---------------------------------------------------------------------------
// A fake Supabase-shim `.from().select().eq().maybeSingle()` query builder —
// same pattern as tests/public-form-resolver.test.ts, extended to TWO
// tenants so cross-tenant isolation has something real to fail against.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

const OASIS_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // the real OASIS id (isOasisInternalTenant)
const OTHER_TENANT_ID = "11111111-2222-4333-8444-555555555555";

const tenants: Row[] = [
  { id: OASIS_TENANT_ID, slug: "oasis-ai-cc", logo_url: null, custom_fields: {} },
  { id: OTHER_TENANT_ID, slug: "other-co", logo_url: null, custom_fields: {} },
];

const forms: Row[] = [
  { id: "f-vsl", tenant_id: OASIS_TENANT_ID, slug: "vsl", name: "Start here", enabled: true },
  { id: "f-protocol", tenant_id: OASIS_TENANT_ID, slug: "protocol", name: "Protocol", enabled: true },
  { id: "f-command", tenant_id: OASIS_TENANT_ID, slug: "command", name: "Command", enabled: true },
  { id: "f-community", tenant_id: OASIS_TENANT_ID, slug: "community", name: "Community", enabled: true },
  { id: "f-fleet", tenant_id: OASIS_TENANT_ID, slug: "fleet", name: "Fleet", enabled: true },
  { id: "f-disabled", tenant_id: OASIS_TENANT_ID, slug: "disabled-path", name: "Disabled", enabled: false },
  // Same slug as OASIS's own, but in ANOTHER tenant — proves resolution never
  // widens past the router's own tenant.
  { id: "f-other-protocol", tenant_id: OTHER_TENANT_ID, slug: "protocol", name: "Other protocol", enabled: true },
];

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private table: "tenants" | "forms") {}
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  async maybeSingle() {
    const rows = this.table === "tenants" ? tenants : forms;
    const data = rows.find((row) => this.filters.every(([c, v]) => row[c] === v));
    return { data: data ?? null, error: null };
  }
}
const db = { from(table: "tenants" | "forms") { return new FakeQuery(table); } } as never;

// ---------------------------------------------------------------------------
// OASIS's real default rules (content/offers/oasis/vsl-routing.json), parsed
// through the same validator production will use.
// ---------------------------------------------------------------------------
const oasisRoutingFile = JSON.parse(readFileSync("content/offers/oasis/vsl-routing.json", "utf8")) as {
  rules: unknown;
};
const oasisRules = parseFormRouting(oasisRoutingFile.rules);

async function destinationFor(rules: readonly FormRoutingRule[], answers: Record<string, unknown>, tenantId = OASIS_TENANT_ID, tenantSlug = "oasis-ai-cc") {
  return resolveRouterDestination(db, { tenantId, tenantSlug, routerFormSlug: "vsl", rules, answers });
}

async function main() {
  console.log("parseFormRouting:");

  console.log("  absent/null/empty routing all parse to no rules");
  assert.deepEqual(parseFormRouting(null), []);
  assert.deepEqual(parseFormRouting(undefined), []);
  assert.deepEqual(parseFormRouting([]), []);

  console.log("  OASIS's real default rules parse without throwing, 6 rules (explicit choices first)");
  assert.equal(oasisRules.length, 6);

  console.log("  rejects go as an absolute URL (never an open redirect at the DATA layer either)");
  assert.throws(
    () => parseFormRouting([{ go: "https://evil.example.com", when_any: [{ path: ["protocol"] }] }]),
    RoutingDefinitionError,
  );

  console.log("  rejects an empty when_any");
  assert.throws(() => parseFormRouting([{ go: "protocol", when_any: [] }]), RoutingDefinitionError);

  console.log("  rejects an unknown top-level key");
  assert.throws(
    () => parseFormRouting([{ go: "protocol", when_any: [{ path: ["protocol"] }], extra: true }]),
    RoutingDefinitionError,
  );

  console.log("  rejects a condition value that is not a non-empty string array");
  assert.throws(() => parseFormRouting([{ go: "protocol", when_any: [{ path: [] }] }]), RoutingDefinitionError);
  assert.throws(() => parseFormRouting([{ go: "protocol", when_any: [{ path: "protocol" }] }]), RoutingDefinitionError);

  console.log("firstMatchingGo / ruleMatches (pure evaluation, HANDOVER table scenarios):");

  console.log("  chose PROTOCOL -> protocol, even with fields that would also match a later rule");
  assert.equal(firstMatchingGo(oasisRules, { path: "protocol", budget: "15k_plus" }), "protocol");

  console.log("  pre-revenue + no budget -> protocol (second disjunct, no path chosen)");
  assert.equal(firstMatchingGo(oasisRules, { monthly_revenue: "under_10k", budget: "none_yet" }), "protocol");

  console.log("  chose COMMAND with revenue $10k+ -> command");
  assert.equal(firstMatchingGo(oasisRules, { path: "command", monthly_revenue: "50k_250k" }), "command");

  console.log("  budget $5k-$15k alone (no path) -> command");
  assert.equal(firstMatchingGo(oasisRules, { budget: "5k_15k" }), "command");

  console.log("  chose COMMUNITY -> community");
  assert.equal(firstMatchingGo(oasisRules, { path: "community" }), "community");

  console.log("  budget 'nothing yet' at a higher revenue band -> community (not fleet)");
  assert.equal(firstMatchingGo(oasisRules, { monthly_revenue: "50k_250k", budget: "none_yet" }), "community");

  console.log("  chose FLEET -> fleet");
  assert.equal(firstMatchingGo(oasisRules, { path: "fleet" }), "fleet");

  console.log("  revenue $250k+ alone (no path, no budget) -> fleet");
  assert.equal(firstMatchingGo(oasisRules, { monthly_revenue: "250k_plus" }), "fleet");

  console.log("  an EXPLICIT choice is never overridden by a budget (rule order regression)");
  for (const budget of ["2k_5k", "5k_15k", "15k_plus"]) {
    assert.equal(firstMatchingGo(oasisRules, { path: "fleet", budget }), "fleet", `fleet + ${budget}`);
    assert.equal(firstMatchingGo(oasisRules, { path: "community", budget }), "community", `community + ${budget}`);
    assert.equal(firstMatchingGo(oasisRules, { path: "protocol", budget }), "protocol", `protocol + ${budget}`);
  }

  console.log("  $250K+ a month goes to FLEET whatever card was picked (the one deliberate override)");
  for (const path of ["protocol", "command", "community", "fleet"]) {
    assert.equal(firstMatchingGo(oasisRules, { path, monthly_revenue: "250k_plus" }), "fleet", path);
  }

  console.log("  no answers at all -> no rule matches (never guesses)");
  assert.equal(firstMatchingGo(oasisRules, {}), null);

  console.log("  an answer combination no rule covers -> no match (falls to the implicit community default)");
  assert.equal(
    firstMatchingGo(oasisRules, { path: "command", monthly_revenue: "under_10k", budget: "under_2k" }),
    null,
  );

  console.log("resolveRouterDestination (database-backed, real OASIS tenant):");

  console.log("  protocol resolves to /f/oasis-ai-cc/protocol");
  assert.equal(await destinationFor(oasisRules, { path: "protocol" }), "/f/oasis-ai-cc/protocol");

  console.log("  command resolves to /f/oasis-ai-cc/command");
  assert.equal(await destinationFor(oasisRules, { path: "command", monthly_revenue: "50k_250k" }), "/f/oasis-ai-cc/command");

  console.log("  community resolves to /f/oasis-ai-cc/community");
  assert.equal(await destinationFor(oasisRules, { path: "community" }), "/f/oasis-ai-cc/community");

  console.log("  fleet resolves to /f/oasis-ai-cc/fleet");
  assert.equal(await destinationFor(oasisRules, { path: "fleet" }), "/f/oasis-ai-cc/fleet");

  console.log("  no match at all falls through to the tracked community route (OASIS has one configured)");
  assert.equal(await destinationFor(oasisRules, {}), "/go/community?form=vsl&t=oasis-ai-cc");

  console.log("  every resolved destination is a RELATIVE path (never an absolute URL)");
  for (const answers of [{ path: "protocol" }, { path: "command", monthly_revenue: "50k_250k" }, { path: "community" }, { path: "fleet" }, {}]) {
    const dest = await destinationFor(oasisRules, answers);
    assert.ok(dest, `expected a destination for ${JSON.stringify(answers)}`);
    assert.ok(dest!.startsWith("/"), `destination must be relative: ${dest}`);
    assert.ok(!dest!.includes("://"), `destination must never carry a scheme: ${dest}`);
  }

  console.log("Refusal behavior (the open-redirect / cross-tenant guards):");

  console.log("  a rule naming ANOTHER tenant's form (same slug) never resolves to it -- falls through to community");
  const crossTenantRule: FormRoutingRule[] = [{ go: "protocol", whenAny: [{ path: ["protocol"] }] }];
  // Router is in OASIS's own tenant; "protocol" exists in BOTH tenants. Must
  // resolve to OASIS's own, never the other tenant's row with the same slug.
  assert.equal(await destinationFor(crossTenantRule, { path: "protocol" }), "/f/oasis-ai-cc/protocol");
  // And explicitly: resolving as if the ROUTER belonged to the other tenant
  // must land on the OTHER tenant's protocol, never OASIS's -- same-tenant
  // scoping, not a slug-wide lookup.
  assert.equal(
    await destinationFor(crossTenantRule, { path: "protocol" }, OTHER_TENANT_ID, "other-co"),
    "/f/other-co/protocol",
  );

  console.log("  a rule naming a DISABLED form in the SAME tenant falls through to community");
  const disabledRule: FormRoutingRule[] = [{ go: "disabled-path", whenAny: [{ path: ["protocol"] }] }];
  assert.equal(await destinationFor(disabledRule, { path: "protocol" }), "/go/community?form=vsl&t=oasis-ai-cc");

  console.log("  a rule naming a form that does not exist at all falls through to community");
  const missingRule: FormRoutingRule[] = [{ go: "no-such-form", whenAny: [{ path: ["protocol"] }] }];
  assert.equal(await destinationFor(missingRule, { path: "protocol" }), "/go/community?form=vsl&t=oasis-ai-cc");

  console.log("  community_link for a tenant with NO community configured resolves to null, not a guess");
  const communityLinkRule: FormRoutingRule[] = [{ go: COMMUNITY_LINK_GO, whenAny: [{ path: ["protocol"] }] }];
  assert.equal(
    await destinationFor(communityLinkRule, { path: "protocol" }, OTHER_TENANT_ID, "other-co"),
    null,
    "no configured community and no other rule -- null means the form's own ordinary behavior, never a guess",
  );

  console.log("  a disabled destination is skipped in favour of a LATER rule that DOES resolve");
  const fallThroughToNextRule: FormRoutingRule[] = [
    { go: "disabled-path", whenAny: [{ path: ["protocol"] }] },
    { go: "fleet", whenAny: [{ path: ["protocol"] }] },
  ];
  assert.equal(await destinationFor(fallThroughToNextRule, { path: "protocol" }), "/f/oasis-ai-cc/fleet");

  console.log("router-cat-preselect:");

  const vslSteps = [
    { fields: [{ name: "path", options: [{ value: "protocol" }, { value: "command" }, { value: "community" }, { value: "fleet" }] }] },
  ];
  console.log("  ?cat=p1..p4 map to the right path value");
  assert.equal(routerPathForCatParam("p1"), "protocol");
  assert.equal(routerPathForCatParam("p2"), "command");
  assert.equal(routerPathForCatParam("p3"), "community");
  assert.equal(routerPathForCatParam("p4"), "fleet");

  console.log("  an unknown cat is ignored, never guessed");
  assert.equal(routerPathForCatParam("p9"), null);
  assert.equal(routerPathForCatParam(""), null);
  assert.equal(routerPathForCatParam(null), null);
  assert.equal(routerPathForCatParam(undefined), null);

  console.log("  routerPrefillForCat seeds {path: value} only when the form actually offers it");
  assert.deepEqual(routerPrefillForCat(vslSteps, "p1"), { path: "protocol" });
  assert.equal(routerPrefillForCat(vslSteps, "p9"), null, "unknown cat");
  assert.equal(routerPrefillForCat([{ fields: [{ name: "email" }] }], "p1"), null, "form has no path field at all");

  console.log("offer-router-routing: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
