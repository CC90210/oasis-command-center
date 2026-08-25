/**
 * The CRM board shows the business, not just the contact.
 *
 * Adon, 2026-08-25: "you can see [it] on the leads tab but you should also be
 * able to click and view the website as well as see all of the leads
 * information, just like on the leads tab, but on the pipeline tab, which is
 * our CRM."
 *
 * /pipeline and /web-leads render the SAME `tenant_records` rows in the SAME
 * tenant. Every business fact was already on the row and simply never read by
 * the pipeline's row model. The SCORE is the one exception -- it lives in
 * leadgen_site_audits and needs a join -- so that join is what this file pins.
 *
 * The index passed in below is a REAL ScoreIndex, not a stub. A fake that
 * implements the caller's own mistake cannot fail, and this repo has been
 * bitten by that exact shape twice (a guard asserting a check was PRESENT
 * rather than that it FIRED). `attachWebsiteScores` takes an optional index for
 * this reason and this reason only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attachWebsiteScores,
  scoreStateSentence,
  DERIVED_SCORE_KEY,
  DERIVED_SCORE_STATE_KEY,
} from "../lib/web-leads/attach-scores";
import type { ScoreIndex } from "../lib/web-leads/scores";

const read = (p: string) => readFileSync(p, "utf8");

// A real index: one scored business, one recorded unreachable.
const index: ScoreIndex = {
  scored: new Map([["biz-scored", 41]]),
  unreachable: new Set(["biz-dead"]),
};

const row = (data: Record<string, unknown>) => ({ id: "r1", data });

async function run() {

  // ---------------------------------------------------------------------------
  // 1. THE FOUR STATES, EACH RESOLVED FROM THE REAL INDEX.
  // ---------------------------------------------------------------------------
  {
    const [scored] = await attachWebsiteScores(
      [row({ website: "https://a.example", webdev_source_business_id: "biz-scored" })],
      index,
    );
    assert.equal(scored.data[DERIVED_SCORE_KEY], 41, "a scored business must carry its number");
    assert.equal(scored.data[DERIVED_SCORE_STATE_KEY], "scored");

    const [dead] = await attachWebsiteScores(
      [row({ website: "https://b.example", webdev_source_business_id: "biz-dead" })],
      index,
    );
    assert.equal(dead.data[DERIVED_SCORE_KEY], null, "an unreachable site has NO score, not a zero");
    assert.equal(dead.data[DERIVED_SCORE_STATE_KEY], "unreachable");

    const [unknown] = await attachWebsiteScores(
      [row({ website: "https://c.example", webdev_source_business_id: "biz-never-audited" })],
      index,
    );
    assert.equal(unknown.data[DERIVED_SCORE_KEY], null);
    assert.equal(unknown.data[DERIVED_SCORE_STATE_KEY], "not_scored");

    // No website at all. This must NOT become "scored 0" -- absence of a website
    // tag in OpenStreetMap means nobody mapped one, not that no site exists.
    const [noSite] = await attachWebsiteScores([row({ website: null })], index);
    assert.equal(noSite.data[DERIVED_SCORE_KEY], null);
    assert.equal(noSite.data[DERIVED_SCORE_STATE_KEY], "no_website");
  }

  // ---------------------------------------------------------------------------
  // 2. A ZERO IS A SCORE. A MISSING SCORE IS NOT A ZERO.
  //
  // The whole feature turns on this distinction, and `0` is falsy, so any
  // `score || null` anywhere in the chain silently demotes the worst sites in the
  // corpus -- which are precisely the ones a rep is meant to call.
  // ---------------------------------------------------------------------------
  {
    const zeroIndex: ScoreIndex = { scored: new Map([["biz-zero", 0]]), unreachable: new Set() };
    const [z] = await attachWebsiteScores(
      [row({ website: "https://z.example", webdev_source_business_id: "biz-zero" })],
      zeroIndex,
    );
    assert.equal(z.data[DERIVED_SCORE_KEY], 0, "a genuine 0 must survive as 0");
    assert.equal(z.data[DERIVED_SCORE_STATE_KEY], "scored", "a genuine 0 is SCORED, not 'not scored'");
  }

  // ---------------------------------------------------------------------------
  // 3. THE ROW IS NOT MUTATED, AND NOTHING ELSE IS LOST.
  // ---------------------------------------------------------------------------
  {
    const original = row({
      website: "https://a.example",
      webdev_source_business_id: "biz-scored",
      business_city: "Montreal",
      stage: "assigned",
    });
    const [out] = await attachWebsiteScores([original], index);
    assert.equal(original.data[DERIVED_SCORE_KEY], undefined, "the input row must not be mutated in place");
    assert.equal(out.data.business_city, "Montreal", "existing fields must survive the attach");
    assert.equal(out.data.stage, "assigned");
    assert.equal(out.id, "r1", "the row identity must survive");
  }

  // An empty board never pays for the index -- and must not throw.
  assert.deepEqual(await attachWebsiteScores([], index), []);

  // ---------------------------------------------------------------------------
  // 4. THE THREE NON-SCORED SENTENCES.
  //
  // Never a zero, a dash, a blank or an empty chart. `no_website` returns null on
  // purpose so the caller falls back to the lead's OWN stored website_condition,
  // which is OpenStreetMap's hedged wording and the one true statement available.
  // ---------------------------------------------------------------------------
  assert.equal(scoreStateSentence("unreachable"), "We could not check this site");
  assert.equal(scoreStateSentence("not_scored"), "Not scored yet");
  assert.equal(scoreStateSentence("no_website"), null, "no_website defers to the lead's verbatim condition");
  assert.equal(scoreStateSentence("scored"), null, "a scored lead renders its number, not a sentence");

  // ---------------------------------------------------------------------------
  // 5. THE BOARD ACTUALLY READS THE BUSINESS FIELDS.
  //
  // Source-matched because oasisRowModel is module-private to a client component.
  // The behavioural half of this feature is covered by the guard test; this only
  // proves the fields are wired at all, which is the thing that was missing.
  // ---------------------------------------------------------------------------
  {
    const view = read("components/manifest/LeadPipelineView.tsx");
    for (const field of [
      "d.website",
      "d.business_city",
      "d.business_address",
      "d.website_condition",
      "d.audit_findings",
    ]) {
      assert.ok(
        view.includes(field),
        `the pipeline row model must read ${field} -- it is already on the row, and not reading it is why the CRM board showed no business`,
      );
    }
    // Both spellings of industry: `webdev_industry` is the rep-facing collapse of
    // 212 raw OSM categories into 18 and is preferred, `industry` is the fallback.
    assert.match(view, /str\(d\.webdev_industry\) \|\| str\(d\.industry\)/);

    // THE ROW MUST NOT BE A SINGLE <Link> ANY MORE.
    //
    // It was, and the moment it gained its own "View site" and "Battle card"
    // links that became an anchor inside an anchor -- invalid HTML that browsers
    // do not render as written (the parser closes the outer <a> early and the row
    // comes apart). React emits it happily and nothing throws, so no test run
    // would ever have caught it. The stretched-link overlay is what replaced it.
    assert.match(
      view,
      /className="absolute inset-0 z-0/,
      "the row link must be a stretched overlay, or the nested website links are anchors inside an anchor",
    );
    assert.doesNotMatch(
      view,
      /<Link\s+href=\{`\$\{basePath\}\/\$\{row\.id\}`\}\s+className="grid/,
      "the row must not wrap the whole grid in an anchor again",
    );
  }

  // ---------------------------------------------------------------------------
  // 6. THE BOARD'S OWN FILTERS APPLY WITH AN EMPTY SEARCH BOX.
  //
  // Fixed 2026-08-25. `const rows = query ? repScopedRows.filter(...) : scopedRows`
  // meant both filters built directly above it only took effect once a rep typed
  // something. With an empty box the board fell back to the pre-filter set, which
  // still carries the ~30,000-row researched prospect pool and ignores ?rep=.
  // ---------------------------------------------------------------------------
  {
    const page = read("app/pipeline/page.tsx");
    assert.doesNotMatch(
      page,
      /\?\s*repScopedRows\.filter\([\s\S]{0,2000}?\n\s*:\s*scopedRows;/,
      "the no-query branch must fall back to repScopedRows, not scopedRows -- otherwise the researched cut and the rep filter only apply while someone is typing",
    );
    assert.match(page, /:\s*repScopedRows;/, "the no-query branch must use repScopedRows");
    // Scores are attached to what is actually rendered, not to the wider set.
    assert.match(page, /attachWebsiteScores\(rows\)/, "scores must be attached to the final filtered rows");
    assert.match(page, /rows=\{rowsWithScores\}/, "the view must receive the enriched rows");
  }


  console.log("pipeline-web-lead-facts ok — the CRM board carries the business, the website and an honest score");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
