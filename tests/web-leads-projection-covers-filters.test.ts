/**
 * web-leads-projection-covers-filters.test.ts — the projection must carry every
 * field the filters actually read.
 *
 * THE BUG THIS EXISTS TO PREVENT (live on production 2026-08-25 → 2026-09-08):
 *
 * fetchLeads reads leads through a 15-column PROJECTION (FILTER_KEYS) rather
 * than the whole `data` blob — a deliberate fix for a 15-second page load. It
 * then runs EVERY filter, sort and count over those projected rows.
 *
 * `owner_name`, `owner_phone` and `owner_verification_state` were never added
 * to that list. So `toWebLead` saw `undefined` for all three on the filter path
 * and produced `ownerName: null` on every lead in the tenant. Consequences,
 * none of which raised an error anywhere:
 *
 *   - `enrichmentTier` graded all 1,955 leads `contactable`, so "Owner named"
 *     and "Verified owner" returned ZERO rows against 1,668 leads that really
 *     do carry an owner name and a phone.
 *   - The older `ownerOnly` toggle (PR #370) was dead on arrival for the same
 *     reason.
 *   - `enrichmentRank` sorting was a no-op, every lead tying at the same rank.
 *
 * The unit tests in web-leads-enrichment.test.ts all passed throughout, because
 * they hand `enrichmentTier` objects that already carry an owner name. The tier
 * logic was never wrong; it was never fed. THAT is the seam this file guards,
 * and it guards it by REPLAYING THE REAL NARROWING rather than by reading the
 * key list and agreeing with it.
 *
 * So: when someone adds a filter that reads a new field, this test fails until
 * the projection carries it.
 */
import assert from "node:assert";
import { FILTER_KEYS, toWebLead } from "../lib/web-leads/data";
import { enrichmentTier, passesEnrichment } from "../lib/web-leads/enrichment";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("web-leads-projection-covers-filters:");

/**
 * Exactly what fetchLeads does to a row before filtering it: keep only the
 * projected keys. Reproduced rather than imported because the point is to test
 * the NARROWING, and a helper shared with the code under test could be changed
 * in lockstep and hide the regression.
 */
function project(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const k of FILTER_KEYS) d[k] = data[k];
  return d;
}

/** A real shape: owner read off the About page, business line published. */
const OWNER_NAMED = {
  business_name: "Coastline Auto Detailing",
  phone: "250-555-0188",
  state: "BC",
  website: "https://coastlineautodetail.ca",
  owner_name: "Marc Lefebvre",
  owner_title: "Owner",
  owner_verification_state: "self_reported",
  webdev_territory_id: "t-1",
};

run("a lead with an owner name survives the projection still named", () => {
  const full = toWebLead({ id: "l1", data: OWNER_NAMED });
  assert.equal(full.ownerName, "Marc Lefebvre", "precondition: the mapper reads owner_name");
  assert.equal(enrichmentTier(full), "named");

  // The real path. This is the assertion that was failing in production.
  const projected = toWebLead({ id: "l1", data: project(OWNER_NAMED) });
  assert.equal(
    projected.ownerName,
    "Marc Lefebvre",
    "owner_name was dropped by the projection — the tier filter and the ownerOnly toggle both go blind here",
  );
  assert.equal(
    enrichmentTier(projected),
    "named",
    "projected lead graded lower than the same lead read whole",
  );
  assert.ok(
    passesEnrichment(projected, "named"),
    '"Owner named and better" must return this lead',
  );
});

run("a verified owner survives the projection still verified", () => {
  const data = { ...OWNER_NAMED, owner_verification_state: "confirmed", owner_phone: "250-555-0199" };
  const projected = toWebLead({ id: "l2", data: project(data) });
  assert.equal(
    enrichmentTier(projected),
    "verified",
    "owner_verification_state or owner_phone was dropped — the top tier can never be reached",
  );
  assert.ok(passesEnrichment(projected, "verified"), '"Verified owner" must return this lead');
});

run("the ownerOnly toggle can still see an owner after projection", () => {
  // Mirrors data.ts's `.filter((l) => (f.ownerOnly ? Boolean(l.ownerName) : true))`.
  const projected = toWebLead({ id: "l3", data: project(OWNER_NAMED) });
  assert.ok(Boolean(projected.ownerName), "ownerOnly would filter this real lead out");
});

run("a genuinely thin lead is NOT promoted by the fix", () => {
  // The fix must not make the tier generous — a lead with no owner and no phone
  // is still `thin` after projection, and a name with no number is still `thin`.
  const noOwner = toWebLead({ id: "l4", data: project({ business_name: "X", state: "ON" }) });
  assert.equal(enrichmentTier(noOwner), "thin");
  assert.equal(passesEnrichment(noOwner, "contactable"), false);

  const nameNoPhone = toWebLead({
    id: "l5",
    data: project({ business_name: "Y", state: "ON", owner_name: "Jo Tran" }),
  });
  assert.equal(enrichmentTier(nameNoPhone), "thin", "a name with no number cannot be called");
});

run("a contradicted owner still sinks after projection", () => {
  const conflicted = toWebLead({
    id: "l6",
    data: project({ ...OWNER_NAMED, owner_verification_state: "conflict" }),
  });
  assert.equal(enrichmentTier(conflicted), "thin", "conflict must survive the projection to sink the lead");
  assert.equal(passesEnrichment(conflicted, "named"), false);
});
