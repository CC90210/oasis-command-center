/**
 * web-leads-enrichment.test.ts — the "what we know" tier a rep prioritises on.
 *
 * The board already ranks by OPPORTUNITY (whose website is worst). This ranks
 * by EVIDENCE (who we can actually reach a decision-maker at). The two answer
 * different questions and the tests below pin the boundary between them, plus
 * the three ways a tier could lie: promoting a lead on absent data, hiding the
 * best leads behind a narrower-looking choice, and surfacing a contradicted one.
 */
import assert from "node:assert";
import {
  ENRICHMENT_TIERS,
  ENRICHMENT_LABELS,
  ENRICHMENT_BLURBS,
  enrichmentTier,
  enrichmentRank,
  passesEnrichment,
  parseEnrichment,
} from "../lib/web-leads/enrichment";
import { parseFilters, filtersToParams, EMPTY_FILTERS } from "../lib/web-leads/filters";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("web-leads-enrichment:");

run("verified needs a NAME and a NUMBER, not just a confirmed state", () => {
  assert.equal(
    enrichmentTier({ ownerName: "Frank Stokovac", ownerPhone: "6045517121", ownerVerification: "confirmed" }),
    "verified",
  );
  // Confirmed with nobody to ask for is a corroborated main line.
  assert.equal(
    enrichmentTier({ ownerName: null, phone: "6045517121", ownerVerification: "confirmed" }),
    "contactable",
  );
  // A name with no number cannot be called at all, whatever the state says.
  assert.equal(
    enrichmentTier({ ownerName: "Frank Stokovac", ownerVerification: "confirmed" }),
    "thin",
  );
});

run("a named owner on the main line is `named`, not `verified`", () => {
  // The overwhelming majority case: we read the name off their About page and
  // hold the number they publish. Real, but nothing independent confirms it.
  assert.equal(
    enrichmentTier({ ownerName: "Rachelle Girardin", phone: "5145551234", ownerVerification: "self_reported" }),
    "named",
  );
  assert.equal(
    enrichmentTier({ ownerName: "Rachelle Girardin", phone: "5145551234", ownerVerification: "unchecked" }),
    "named",
  );
  // lookup_failed means we could not check, which is not evidence against.
  assert.equal(
    enrichmentTier({ ownerName: "Rachelle Girardin", phone: "5145551234", ownerVerification: "lookup_failed" }),
    "named",
  );
});

run("a contradicted lead never ranks as workable", () => {
  // conflict is quarantined off the board upstream. If one reaches the UI it is
  // a bug, and it must SINK rather than be handed to a rep as a good lead.
  assert.equal(
    enrichmentTier({ ownerName: "Marcus Webb", ownerPhone: "6045517121", ownerVerification: "conflict" }),
    "thin",
  );
  assert.equal(enrichmentRank({ ownerVerification: "conflict", ownerName: "X Y", phone: "1" }), 0);
});

run("no phone is always thin, however much else we hold", () => {
  assert.equal(enrichmentTier({}), "thin");
  assert.equal(enrichmentTier({ ownerName: "A B", phone: "", ownerPhone: "  " }), "thin");
  assert.equal(enrichmentTier({ phone: null, ownerPhone: null }), "thin");
});

run("choosing a tier means that tier AND better", () => {
  const verified = { ownerName: "A B", ownerPhone: "1", ownerVerification: "confirmed" };
  const named = { ownerName: "A B", phone: "1" };
  const contactable = { phone: "1" };
  const thin = {};

  // A rep asking for named owners must still see the verified ones. Hiding the
  // strongest prospects behind a narrower-looking choice is the trap here.
  assert.equal(passesEnrichment(verified, "named"), true);
  assert.equal(passesEnrichment(named, "named"), true);
  assert.equal(passesEnrichment(contactable, "named"), false);
  assert.equal(passesEnrichment(thin, "named"), false);

  assert.equal(passesEnrichment(verified, "verified"), true);
  assert.equal(passesEnrichment(named, "verified"), false);

  // "all" is a real no-op, including for the contradicted case.
  for (const l of [verified, named, contactable, thin]) {
    assert.equal(passesEnrichment(l, "all"), true);
  }
});

run("the tier order is the ranking, and every tier has rep-facing copy", () => {
  assert.deepEqual([...ENRICHMENT_TIERS], ["thin", "contactable", "named", "verified"]);
  for (const t of ENRICHMENT_TIERS) {
    assert.ok(ENRICHMENT_LABELS[t] && ENRICHMENT_LABELS[t].length < 30, t);
    assert.ok(ENRICHMENT_BLURBS[t] && ENRICHMENT_BLURBS[t].length > 20, t);
    // No em dashes in anything a rep or a customer reads.
    assert.ok(!ENRICHMENT_LABELS[t].includes("—"), `${t} label has an em dash`);
    assert.ok(!ENRICHMENT_BLURBS[t].includes("—"), `${t} blurb has an em dash`);
  }
});

run("an unknown filter value falls back to `all`, never to a narrow tier", () => {
  // A typo in a shared URL must widen to everything, not silently hide the
  // board behind a filter the rep did not choose.
  for (const bad of ["", null, undefined, "VERIFIED", "best", "1", "conflict"]) {
    assert.equal(parseEnrichment(bad as string | null), "all", String(bad));
  }
  for (const good of ENRICHMENT_TIERS) assert.equal(parseEnrichment(good), good);
});

run("the filter round-trips through the URL", () => {
  const f = { ...EMPTY_FILTERS, enrichment: "verified" as const };
  const sp = filtersToParams(f);
  assert.equal(sp.get("enrich"), "verified");
  assert.equal(parseFilters(sp).enrichment, "verified");

  // The default must NOT appear in the URL, so a shared link stays clean and
  // "no filter" cannot drift into a stored preference.
  assert.equal(filtersToParams(EMPTY_FILTERS).get("enrich"), null);
  assert.equal(parseFilters(new URLSearchParams()).enrichment, "all");
});

run("the sort is a real option and defaults stay put", () => {
  const sp = filtersToParams({ ...EMPTY_FILTERS, sort: "enriched_desc" });
  assert.equal(sp.get("sort"), "enriched_desc");
  assert.equal(parseFilters(sp).sort, "enriched_desc");
  // An unknown sort still falls back to the board's default.
  assert.equal(parseFilters(new URLSearchParams("sort=nonsense")).sort, "opportunity");
});

console.log("web-leads-enrichment ok");
