import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { WEBSITE_SALES_STAGES } from "../lib/website-sales";
import { groupLeadsByStage, filterByRep, UNRECOGNIZED_STAGE, PIPELINE_STAGE_LEAD_CAP } from "../lib/web-leads/pipeline";
import type { PipelineLead } from "../lib/web-leads/data";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

function lead(overrides: Partial<PipelineLead> & { id: string }): PipelineLead {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Business",
    phone: overrides.phone ?? "416-555-0100",
    city: overrides.city ?? "Toronto",
    province: overrides.province ?? "ON",
    industry: overrides.industry ?? null,
    address: overrides.address ?? null,
    postal: overrides.postal ?? null,
    websiteUrl: overrides.websiteUrl ?? null,
    websiteCondition: overrides.websiteCondition ?? "Not checked",
    auditFindings: overrides.auditFindings ?? "Not audited yet - confirm on the call",
    territoryId: overrides.territoryId ?? "territory-1",
    territoryName: overrides.territoryName ?? "Toronto, ON",
    osmCategory: overrides.osmCategory ?? null,
    firstSeen: overrides.firstSeen ?? null,
    stage: overrides.stage ?? null,
    assignedTo: overrides.assignedTo ?? null,
  };
}

// ---------------------------------------------------------------------------
// Every one of CC's fourteen stages is ALWAYS present, in WEBSITE_SALES_STAGES'
// own order, even with zero leads. Most stages are empty today (outcome
// logging only just shipped) -- an empty column must render plainly, never
// be hidden as if the stage didn't exist.
// ---------------------------------------------------------------------------
{
  const groups = groupLeadsByStage([]);
  assert.equal(groups.length, WEBSITE_SALES_STAGES.length + 1, "one group per known stage, plus unrecognized");
  assert.deepEqual(
    groups.slice(0, -1).map((g) => g.stage),
    WEBSITE_SALES_STAGES,
    "group order must follow WEBSITE_SALES_STAGES exactly -- a rename there must reorder/break this, never silently diverge",
  );
  for (const g of groups) {
    assert.equal(g.count, 0);
    assert.deepEqual(g.leads, []);
    assert.equal(g.truncated, false);
  }
  assert.equal(groups[groups.length - 1].stage, UNRECOGNIZED_STAGE, "unrecognized bucket is last");
}

// ---------------------------------------------------------------------------
// THE UNRECOGNIZED-STAGE RULE: a stage value this board doesn't know about
// must surface somewhere visible, never vanish. This covers a stage string
// that matches nothing in WEBSITE_SALES_STAGES, AND a lead with no stage at
// all (null/missing) -- both are real possibilities since data.stage is free
// text in a JSON column with no DB CHECK constraint pinning its vocabulary.
// ---------------------------------------------------------------------------
{
  const leads = [
    lead({ id: "a", stage: "researched" }),
    lead({ id: "b", stage: "reached" }), // not a WEBSITE_SALES_STAGES value
    lead({ id: "c", stage: null }),
    lead({ id: "d", stage: "not_a_real_stage" }),
    lead({ id: "e", stage: "connected" }),
  ];
  const groups = groupLeadsByStage(leads);
  const totalCounted = groups.reduce((sum, g) => sum + g.count, 0);
  assert.equal(totalCounted, leads.length, "no lead may be dropped -- every input lead lands in exactly one bucket");

  const unknown = groups.find((g) => g.stage === UNRECOGNIZED_STAGE)!;
  assert.equal(unknown.count, 3, "reached / null / not_a_real_stage all land in unrecognized");
  assert.deepEqual(
    unknown.leads.map((l) => l.id).sort(),
    ["b", "c", "d"],
    "the specific unrecognized leads must be the ones actually surfaced, not just counted",
  );

  const researched = groups.find((g) => g.stage === "researched")!;
  assert.deepEqual(researched.leads.map((l) => l.id), ["a"]);
  const connected = groups.find((g) => g.stage === "connected")!;
  assert.deepEqual(connected.leads.map((l) => l.id), ["e"]);
}

// ---------------------------------------------------------------------------
// The per-stage lead list is capped for payload size, but `count` must never
// lie -- it is the TRUE total even when `leads` is truncated to
// PIPELINE_STAGE_LEAD_CAP, and `truncated` says so honestly.
// ---------------------------------------------------------------------------
{
  const many = Array.from({ length: PIPELINE_STAGE_LEAD_CAP + 7 }, (_, i) =>
    lead({ id: `bulk-${i}`, stage: "researched" }),
  );
  const groups = groupLeadsByStage(many);
  const researched = groups.find((g) => g.stage === "researched")!;
  assert.equal(researched.count, PIPELINE_STAGE_LEAD_CAP + 7, "count is the true total, never capped");
  assert.equal(researched.leads.length, PIPELINE_STAGE_LEAD_CAP, "the returned list is capped");
  assert.equal(researched.truncated, true);

  const other = groups.find((g) => g.stage === "assigned")!;
  assert.equal(other.truncated, false, "a stage under the cap is never marked truncated");
}

// ---------------------------------------------------------------------------
// filterByRep: the admin-only narrowing, case-insensitive and whitespace-
// trimmed to match visibleToViewer's own comparison convention (lib/web-leads/data.ts).
// ---------------------------------------------------------------------------
{
  const leads = [
    lead({ id: "a", assignedTo: "rep-1" }),
    lead({ id: "b", assignedTo: "REP-1" }),
    lead({ id: "c", assignedTo: "rep-2" }),
    lead({ id: "d", assignedTo: null }),
  ];
  assert.deepEqual(
    filterByRep(leads, "rep-1").map((l) => l.id),
    ["a", "b"],
    "case-insensitive match on assignedTo",
  );
  assert.deepEqual(filterByRep(leads, null), leads, "no rep filter is a passthrough");
  assert.deepEqual(filterByRep(leads, ""), leads, "an empty rep filter is a passthrough");
  assert.deepEqual(filterByRep(leads, "  rep-2  "), leads.filter((l) => l.id === "c"), "surrounding whitespace is trimmed");
  assert.deepEqual(filterByRep(leads, "nobody"), [], "a rep with no leads returns an empty list, not everything");
}

// ---------------------------------------------------------------------------
// Auth spine: mirrors the audit route's guard test (web-leads-guards.test.ts)
// exactly for the new pipeline route -- 401 unresolved, session.ok (not
// truthiness), session.tenantId actually referenced, 403 on a tenant
// mismatch, both BEFORE any read.
// ---------------------------------------------------------------------------
{
  const route = "app/api/web-leads/pipeline/route.ts";
  const src = read(route);
  assert.match(src, /resolveSessionContext/, `${route} must resolve the caller`);
  assert.match(
    src,
    /if\s*\(\s*!\s*session\.ok\s*\)/,
    `${route} must branch on session.ok, not on session's truthiness`,
  );
  assert.match(src, /status:\s*401/, `${route} must fail closed on an unresolved caller`);
  assert.match(src, /session\.tenantId/, `${route} must reference session.tenantId`);
  assert.match(src, /status:\s*403/, `${route} must refuse a caller from another tenant with a 403`);

  // The 401 and 403 checks must come BEFORE the pipeline read, not after --
  // an auth check downstream of the read it's supposed to guard is a no-op.
  // Searches the CALL site (`await fetchPipelineLeads(`), not the import
  // statement at the top of the file, which would always sort first and make
  // this assertion vacuous.
  const authIdx = src.search(/if\s*\(\s*!\s*session\.ok\s*\)/);
  const readIdx = src.search(/await\s+fetchPipelineLeads\(/);
  assert.ok(authIdx >= 0 && readIdx >= 0 && authIdx < readIdx, `${route} must check auth before reading`);

  // Role scoping: a tenant check alone is not sufficient (#237) -- the route
  // must build a Viewer off session.teamRole/session.isAdmin and gate the
  // admin-only rep filter behind isScopedContractor, not apply it blindly.
  assert.match(src, /session\.teamRole/, `${route} must reference session.teamRole`);
  assert.match(src, /session\.isAdmin/, `${route} must reference session.isAdmin`);
  assert.match(
    src,
    /isScopedContractor/,
    `${route} must gate the rep filter behind isScopedContractor -- otherwise a scoped agent could be tricked into thinking ?rep= does something, or worse, it could widen their view`,
  );
}

// ---------------------------------------------------------------------------
// fetchPipelineLeads (lib/web-leads/data.ts) must actually WIRE visibleToViewer
// into its own body, not merely have the predicate exist unused elsewhere in
// the file -- same isolation technique web-leads-guards.test.ts uses for
// fetchLeads, because presence-somewhere-in-the-file previously passed a
// version of this codebase where the wiring was missing.
// ---------------------------------------------------------------------------
{
  const data = read("lib/web-leads/data.ts");
  const code = data.replace(/\/\*[\s\S]*?\*\//g, "");
  const body = code.match(/export async function fetchPipelineLeads\([\s\S]*?\r?\n\}\r?\n/);
  assert.ok(body, "must find fetchPipelineLeads() in lib/web-leads/data.ts");
  assert.match(
    body![0],
    /visibleToViewer/,
    "fetchPipelineLeads must apply visibleToViewer scoping -- an agent-role viewer must see only their own leads on the pipeline board",
  );
  assert.match(
    body![0],
    /\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/,
    "fetchPipelineLeads must pin the tenant on its read",
  );
  // The leadgen source marker: this tenant also holds OASIS's own agency-CRM
  // leads (same tenant_id, same entity_type='lead' -- see fetchPipelineLeads'
  // doc comment) -- without this filter the pipeline board would show that
  // book mixed in with this engine's leads.
  assert.match(
    body![0],
    /territoryId\s*!==\s*null/,
    "fetchPipelineLeads must filter to leads carrying the leadgen source marker (webdev_territory_id / territoryId)",
  );
}

// ---------------------------------------------------------------------------
// NO WRITE PATH. This build is a view, never a second engine -- the route,
// its data-layer read, and the grouping module must never call a mutating
// Supabase/Postgrest method or export any handler beyond GET.
// ---------------------------------------------------------------------------
{
  const routeSrc = read("app/api/web-leads/pipeline/route.ts");
  assert.doesNotMatch(routeSrc, /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/, "the pipeline route must expose GET only -- no write handler");
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /updateRecord\(/, /patch_tenant_record_data/]) {
    assert.doesNotMatch(routeSrc, forbidden, `app/api/web-leads/pipeline/route.ts must not contain ${forbidden} -- this build writes nothing`);
  }

  const pipelineLib = read("lib/web-leads/pipeline.ts");
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /updateRecord\(/, /patch_tenant_record_data/]) {
    assert.doesNotMatch(pipelineLib, forbidden, `lib/web-leads/pipeline.ts must not contain ${forbidden} -- this build writes nothing`);
  }

  const data = read("lib/web-leads/data.ts");
  const code = data.replace(/\/\*[\s\S]*?\*\//g, "");
  const body = code.match(/export async function fetchPipelineLeads\([\s\S]*?\r?\n\}\r?\n/);
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.doesNotMatch(body![0], forbidden, `fetchPipelineLeads must not contain ${forbidden} -- read-only`);
  }
}

// ---------------------------------------------------------------------------
// The board reads stage names and order from WEBSITE_SALES_STAGES itself,
// never a hardcoded copy -- a rename in lib/website-sales.ts must break this
// build's typecheck/tests rather than silently render an empty column.
// ---------------------------------------------------------------------------
{
  const pipelineLib = read("lib/web-leads/pipeline.ts");
  assert.match(pipelineLib, /import\s*\{[^}]*WEBSITE_SALES_STAGES[^}]*\}\s*from\s*["']@\/lib\/website-sales["']/, "pipeline.ts must import WEBSITE_SALES_STAGES from lib/website-sales, not redeclare it");
}

// ---------------------------------------------------------------------------
// Nav consolidation (2026-08-23 revamp): the standalone "Web Pipeline" tab
// this block used to require is GONE -- the operator said, verbatim, "Not a
// separate pipeline page." Pipeline and Territories are in-page views inside
// /web-leads now (?view=pipeline / ?view=territories, lib/web-leads/filters.ts),
// reached through a segmented control, not a second sidebar entry. WEBDEV_NAV
// keeps exactly one Leads entry; CC_NAV, SUN_NAV and SUGA_NAV -- shared with
// other live tenants -- must still be untouched.
// ---------------------------------------------------------------------------
{
  const nav = read("lib/nav-config.ts");
  const webdevBlock = nav.match(/export const WEBDEV_NAV[\s\S]*?\];/);
  assert.ok(webdevBlock, "must find WEBDEV_NAV block");
  assert.match(webdevBlock![0], /\.\.\.CC_NAV/, "WEBDEV_NAV must still spread CC_NAV -- additive only");
  assert.match(webdevBlock![0], /href:\s*"\/web-leads"/, "the existing Leads entry must still be present");
  assert.doesNotMatch(
    webdevBlock![0],
    /href:\s*"\/web-leads\/pipeline"/,
    "the standalone Web Pipeline nav entry must be gone -- Pipeline is now an in-page view, not a second sidebar destination",
  );
  // The route itself must still resolve -- old links/bookmarks to
  // /web-leads/pipeline must redirect into the new view, never 404.
  const pipelinePage = read("app/web-leads/pipeline/page.tsx");
  assert.match(pipelinePage, /redirect\(/, "app/web-leads/pipeline/page.tsx must redirect rather than 404 or render its own page");
  assert.match(pipelinePage, /view=pipeline/, "the redirect must land on the pipeline view");
}

console.log("web-leads-pipeline ok");
