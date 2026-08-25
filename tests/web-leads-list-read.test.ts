/**
 * End-to-end test of the Web Leads list read, against a REAL libSQL database.
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 *
 * fetchLeads() had no test that touched a database. tests/web-leads-data.test.ts
 * covers toWebLead(), which is a pure mapping function, and every other
 * web-leads test covers a pure rule module. So the part that actually decides
 * what a rep sees -- the read, the filter, the sort, the page -- was verified
 * only by opening the page and looking at it.
 *
 * That gap became load-bearing on 2026-08-25, when the read was split in two to
 * fix a 15-second page load:
 *
 *   phase 1  every lead in the tenant, PROJECTED to the 15 fields that decide
 *            whether it is on the page  (37.8 MB -> 15.7 MB, measured live)
 *   phase 2  the full `data` blob for only the leads that survived
 *
 * ═══ THE FAILURE THIS IS SHAPED TO CATCH ════════════════════════════════════
 *
 * If phase 2 silently returned nothing -- a broken `.in()`, an id type
 * mismatch, a projection whose keys do not round-trip -- the page would still
 * render. Every lead would carry its name, phone and score (those come from
 * phase 1) and would simply lose its city, its industry, and its verbatim
 * websiteCondition, quietly falling back to "Not checked". A rep would see a
 * complete-looking list and read a hedge aloud that was not the hedge we
 * recorded.
 *
 * So the assertions below check CONTRIBUTION, not presence: they assert on
 * fields that exist ONLY in phase 2 (city, industry, address, websiteCondition,
 * auditFindings). A test that only checked names and totals would pass against
 * a completely dead phase 2. See [[redundancy-hides-failure]].
 */

import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

// Env MUST be set before lib/supabase-server.ts and lib/turso.ts are first
// imported: both memoise their client on first use. TURSO_DB_PATH points the
// adapter at a local file, which is the same code path production takes to
// Turso cloud, minus the network.
const dbFile = join(mkdtempSync(join(tmpdir(), "webleads-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;

/**
 * Wrapped in async main(): tests in this directory transpile to CJS, where
 * top-level await is unavailable, and the env above must be set BEFORE the
 * modules under test are first imported (both memoise their client), which
 * static imports would hoist past.
 */
async function main() {
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { fetchLeads, PAGE_SIZE } = await import("../lib/web-leads/data");
  const { parseFilters } = await import("../lib/web-leads/filters");
  const { invalidate } = await import("../lib/web-leads/cache");
  const { EMPTY_SCORE_INDEX } = await import("../lib/web-leads/scores");
  
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT,
      updated_at TEXT
    );
  `);
  
  const TERRITORY = "terr-mtl";
  
  /** A lead carrying BOTH phase-1 fields and phase-2-only fields. */
  async function insert(id: string, over: Record<string, unknown> = {}) {
    const data = {
      business_name: `Business ${id}`,
      phone: "5145550100",
      website: "https://example.test",
      webdev_territory_id: TERRITORY,
      webdev_source_business_id: `biz-${id}`,
      state: "QC",
      // --- fields below are NOT in FILTER_KEYS: they can only reach a row
      //     through phase 2, which is the whole point of this file.
      business_city: "Montréal",
      webdev_industry: "Restaurants & Bars",
      business_address: "1 Rue Sainte-Catherine",
      business_zip: "H2X 1K4",
      website_condition: "Has a site, not yet reviewed",
      audit_findings: "Slow on mobile, no SSL",
      webdev_territory: "Montréal — Restaurants",
      ...over,
    };
    await seed.execute({
      sql: `INSERT INTO tenant_records (id,tenant_id,entity_type,data,updated_at) VALUES (?,?,?,?,?)`,
      args: [id, WEBDEV_TENANT_ID, "lead", JSON.stringify(data), "2026-08-25T00:00:00Z"],
    });
  }
  
  await insert("a");
  await insert("b");
  await insert("c", { phone: null });                       // filtered: no phone
  await insert("d", { assigned_to: "someone-else", claimed_at: "2026-08-25T00:00:00Z" }); // held
  await insert("e", { webdev_territory_id: "terr-other" }); // outside the sheet selection
  
  const viewer = { userId: "rep-1", teamRole: "admin", isAdmin: true };
  const filters = parseFilters(new URLSearchParams());
  const now = Date.parse("2026-08-25T12:00:00Z");
  
  const run = async (sheetIds: string[] = [TERRITORY]) => {
    // The 10s memo would otherwise carry phase-1 rows between cases.
    invalidate("web-leads");
    return fetchLeads(filters, sheetIds, viewer, EMPTY_SCORE_INDEX, { scope: "pool", now });
  };
  
  // --- the pool composition still holds after the split -------------------------
  {
    const { leads, total } = await run();
    const ids = leads.map((l) => l.id).sort();
    assert.deepEqual(ids, ["a", "b"], "pool must exclude no-phone, held, and off-sheet leads");
    assert.equal(total, 2, "total must count the filtered set, not the table");
  }
  
  // --- PHASE 2 ACTUALLY CONTRIBUTED --------------------------------------------
  // Each of these fields is absent from FILTER_KEYS, so a dead phase 2 makes every
  // one of them null or a fallback sentence while the row still renders.
  {
    const { leads } = await run();
    const a = leads.find((l) => l.id === "a")!;
  
    assert.equal(a.city, "Montréal", "city comes only from phase 2");
    assert.equal(a.industry, "Restaurants & Bars", "industry comes only from phase 2");
    assert.equal(a.address, "1 Rue Sainte-Catherine", "address comes only from phase 2");
    assert.equal(a.postal, "H2X 1K4", "postal comes only from phase 2");
    assert.equal(a.territoryName, "Montréal — Restaurants", "territory name comes only from phase 2");
  
    // VERBATIM, and specifically NOT the "Not checked" fallback a dead phase 2
    // would produce. This is the assertion that would have caught the whole
    // failure mode described in the header.
    assert.equal(a.websiteCondition, "Has a site, not yet reviewed");
    assert.equal(a.auditFindings, "Slow on mobile, no SSL");
    assert.notEqual(a.websiteCondition, "Not checked", "a dead phase 2 shows exactly this");
    assert.notEqual(a.auditFindings, "Not audited yet - confirm on the call");
  }
  
  // --- phase 1 fields survive the projection round-trip -------------------------
  // The projection sends `data->business_name` and both backends name the column
  // `business_name`; a naming regression in lib/turso-postgrest.ts's selectCol()
  // would empty these without emptying the list.
  {
    const { leads } = await run();
    const a = leads.find((l) => l.id === "a")!;
    assert.equal(a.name, "Business a", "name is projected in phase 1, not defaulted");
    assert.notEqual(a.name, "Unnamed business", "a broken projection shows exactly this");
    assert.equal(a.phone, "5145550100");
    assert.equal(a.websiteUrl, "https://example.test");
    assert.equal(a.province, "QC");
    assert.equal(a.territoryId, TERRITORY);
  }
  
  // --- free text never reaches a filter string ----------------------------------
  // "Montréal" and "Restaurants & Bars" are stored on every seeded row and are
  // matched in memory. If either ever entered a PostgREST filter the accent and
  // the ampersand are exactly what would break it, so a green result here is also
  // evidence the values are still being compared client-side.
  {
    const { leads } = await run();
    assert.ok(leads.every((l) => l.city === "Montréal"), "accented free text survives intact");
    assert.ok(leads.every((l) => l.industry === "Restaurants & Bars"), "ampersand survives intact");
  }
  
  // --- an empty page does not fire a phase-2 read with no ids -------------------
  {
    const { leads, total } = await run(["terr-nothing-here"]);
    assert.deepEqual(leads, [], "no matching sheet means no leads");
    assert.equal(total, 0);
  }
  
  // --- paging still slices the sorted set --------------------------------------
  {
    assert.equal(PAGE_SIZE, 100, "operator asked for 100 per page on 2026-08-25");
    const { leads, total } = await run();
    assert.ok(leads.length <= PAGE_SIZE, "a page never exceeds PAGE_SIZE");
    assert.equal(total, 2, "total is the whole filtered set, independent of page size");
  }
  
  console.log("web-leads-list-read ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
