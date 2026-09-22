import { fetchSheets, fetchLeads } from "../lib/web-leads/data";
import { selectSheetIds, buildFacets } from "../lib/web-leads/queries";
import { EMPTY_FILTERS } from "../lib/web-leads/filters";
import { fetchScoreIndex } from "../lib/web-leads/scores";

async function main() {
  console.log("=== Testing Web Leads Fetch ===");
  const sheets = await fetchSheets();
  console.log("Total sheets fetched:", sheets.length);

  const ccSheets = sheets.filter((s) => s.vertical === "CC Leads");
  console.log("CC Leads sheets count:", ccSheets.length);

  const filters = { ...EMPTY_FILTERS, industries: ["CC Leads"] };
  const facets = buildFacets(sheets, filters);
  console.log("Facets totalCallable:", facets.totalCallable);

  const selectedSheetIds = selectSheetIds(sheets, filters);
  console.log("Selected sheet IDs for CC Leads:", selectedSheetIds);

  const viewer = { userId: "test-user-1", isAdmin: true, role: "admin" as const, teamRole: "admin" as const };
  const scoreIndex = await fetchScoreIndex();
  const now = Date.now();

  const { leads, total } = await fetchLeads(filters, selectedSheetIds, viewer, scoreIndex, { scope: "pool", now });
  console.log(`\n=== SUCCESS! Fetched ${leads.length} leads out of ${total} total for CC Leads filter. ===`);
  for (let i = 0; i < Math.min(leads.length, 5); i++) {
    console.log(`  Lead ${i+1}: ${leads[i].name} | Phone: ${leads[i].phone} | Territory: ${leads[i].territoryId} | Province: ${leads[i].province}`);
  }
}

main().catch(console.error);
