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
  parked: new Set(["biz-parked"]),
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
    const zeroIndex: ScoreIndex = { scored: new Map([["biz-zero", 0]]), unreachable: new Set(), parked: new Set() };
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
  // A domain that is FOR SALE. Its own sentence, not "unreachable" -- we
  // reached it perfectly and got a broker's listing.
  assert.equal(scoreStateSentence("parked"), "Domain listed for sale, no live site");

  // ---------------------------------------------------------------------------
  // 4b. A PARKED DOMAIN NEVER CARRIES A NUMBER.
  //
  // 2026-08-25: all 53 HugeDomains parking pages in the corpus scored EXACTLY
  // 82 and every one landed in the top tier, because a parking page genuinely
  // is fast, HTTPS, mobile-friendly and full of CTAs. Two of them reached a
  // prospect as "best-scoring competitors" on a live battle card.
  // ---------------------------------------------------------------------------
  {
    const [p] = await attachWebsiteScores(
      [row({ website: "http://www.ambianceofindia.com", webdev_source_business_id: "biz-parked" })],
      index,
    );
    assert.equal(p.data[DERIVED_SCORE_KEY], null, "a parked domain must never carry a score");
    assert.equal(
      p.data[DERIVED_SCORE_STATE_KEY],
      "parked",
      "a parked domain must say so, not hide behind 'not scored yet' or 'unreachable'",
    );
  }

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
  // 6. THE SCORE JOIN RUNS ON WHAT IS ACTUALLY RENDERED.
  //
  // RE-AIMED 2026-08-25 when origin/main (#295) moved the board's filtering into
  // the DATABASE. This block used to pin an in-memory shape:
  // `const rows = query ? repScopedRows.filter(...) : scopedRows`, where the
  // no-query branch skipped both the researched cut and the ?rep= filter -- a
  // real bug at the time. That whole structure is gone: `listOasisPipelineWindow`
  // now applies scope, the researched cut, the rep filter and the search before
  // returning one bounded page of rows, so the bug it guarded cannot exist.
  //
  // Deleting the block would have been wrong too -- what still matters is that
  // the score join runs on the PAGED window rather than on some wider set, and
  // that it stays gated on the tenant.
  // ---------------------------------------------------------------------------
  {
    const page = read("app/pipeline/page.tsx");
    assert.match(
      page,
      /attachWebsiteScores\(named\)/,
      "scores must be attached to the already-scoped, already-paged window",
    );
    assert.match(
      page,
      /const named = await attachAssignedNames\(pipelineWindow\.rows, tenantId\)/,
      "the window from the DB query is what gets enriched -- not a re-fetched or wider set",
    );
    assert.match(page, /rows=\{rows\}/, "the view must receive the enriched rows");

    // ─────────────────────────────────────────────────────────────────────
    // 7. THE SCORE JOIN IS GATED ON THE TENANT.
    //
    // Caught by independent review 2026-08-25. THREE slugs render this page
    // (`oasis`, `oasis-ai-cc`, `oasis-webdev`) but every query inside
    // fetchScoreIndex is pinned to WEBDEV_TENANT_ID = oasis-ai-cc. Ungated,
    // another tenant's board resolves its rows against a DIFFERENT tenant's
    // audit index: a miss shows "Not scored yet" on a lead that may be scored,
    // and a colliding business id would show one tenant a number measured from
    // another tenant's website. `oasis-webdev` holds 53 real leads.
    // ─────────────────────────────────────────────────────────────────────
    assert.match(
      page,
      /tenantId === WEBDEV_TENANT_ID \? await attachWebsiteScores\(named\) : named/,
      "the score join must be gated on the web-leads tenant -- fetchScoreIndex is pinned to it, so another tenant would resolve against the wrong index",
    );
  }

  // ---------------------------------------------------------------------------
  // 8. THE BATTLE CARD LINK ONLY APPEARS ON ROWS THAT HAVE ONE.
  //
  // /web-leads/<id> pins fetchLead to WEBDEV_TENANT_ID, so the link 404s for
  // another tenant's row or for an ordinary CRM lead typed in by hand. A button
  // that reliably 404s is worse than no button.
  // ---------------------------------------------------------------------------
  {
    const view = read("components/manifest/LeadPipelineView.tsx");
    assert.match(
      view,
      /str\(d\.webdev_source_business_id\)/,
      "the row model must decide whether a row is a web-lead from its source business id",
    );
    assert.match(view, /isWebLead: Boolean\(webLeadBusinessId\)/);
    assert.match(
      view,
      /\{m\.isWebLead && \(\s*<Link\s+href=\{`\/web-leads\//,
      "the battle-card link must be gated on isWebLead",
    );

    // The DETAIL page no longer carries its own compact business band. This
    // used to assert a battle-card link inside one; origin/main (#295) shipped
    // `LeadWebsiteAuditBand`, which renders the website, industry, condition
    // and findings for every viewer, so a second band of the same fields was
    // deleted rather than merged. What the detail page owes now is the full
    // card, which section 9 covers -- plus the band, unconditionally, so a
    // viewer who cannot load the card is never left with nothing.
    const detail = read("app/pipeline/[id]/page.tsx");
    assert.match(
      detail,
      /<LeadWebsiteAuditBand data=\{activeRecord\.data\} \/>/,
      "the website band must render for EVERY viewer -- it is the floor under the battle card",
    );
    assert.doesNotMatch(
      detail,
      /\{[^}]*&& <LeadWebsiteAuditBand/,
      "the website band must not be gated -- gating it is what could leave a collaborator with nothing",
    );
  }

  // ---------------------------------------------------------------------------
  // 9. THE PIPELINE AND THE LEADS TAB ARE SYNONYMOUS.
  //
  // Adon, 2026-08-25: "we have to ensure that the leads tab and the pipeline are
  // completely synonymous... The pipeline is how we're going to track whose lead
  // is who. It should be what's going to be used more than the leads tab...
  // Right now as soon as you claim a lead, you're losing a lot of the
  // information that we have on the leads tab."
  //
  // The loss was structural, not a missing field. Claiming a lead moves it OUT
  // of the /web-leads pool and onto the pipeline, and the pipeline record
  // rendered a CRM form -- so the score, percentile, seven-axis profile, named
  // competitors, everything-wrong list, sales angles and objection panel all
  // vanished at exactly the moment a rep committed to calling.
  // ---------------------------------------------------------------------------
  {
    const detail = read("app/pipeline/[id]/page.tsx");

    // THE SAME COMPONENT. Not a pipeline-shaped copy: a second rendering of one
    // business's failings is two things that can disagree mid-call, which is the
    // argument BusinessFacts already settled between the drawer and the card.
    assert.match(
      detail,
      /import \{ BattleCard \} from "@\/components\/web-leads\/BattleCard";/,
      "the pipeline must import the REAL BattleCard, never reimplement it",
    );
    assert.match(
      detail,
      /<BattleCard leadId=\{id\} canMutate=\{canMutateLead\} embedded \/>/,
      "the pipeline lead page must render the battle card, and pass ITS OWN mutation gate into it",
    );

    // ─── NOBODY EVER GETS NEITHER ─────────────────────────────────────────
    //
    // Found in review 2026-08-25. This page admits a viewer via
    // `canOpenOasisSalesRecord`, which accepts the assignee OR a listed
    // COLLABORATOR -- that is what makes the opener-to-closer handoff work.
    // The battle card fetches through `visibleToViewer`, which accepts the
    // assignee ONLY and has no collaborator concept. So a collaborator opens
    // the record and the card inside it 404s.
    //
    // On its own that is a survivable error message. Combined with suppressing
    // the business band whenever a card is EXPECTED, it left exactly those
    // people with no business details at all -- worse than the state this whole
    // change set out to fix. Both gates now ask the same question.
    assert.match(
      detail,
      /import \{ visibleToViewer \} from "@\/lib\/web-leads\/data";/,
      "the page must ask the SAME visibility function the battlecard API asks",
    );
    assert.match(
      detail,
      /const willRenderBattleCard = Boolean\(\s*webLeadBusinessId && cardViewer && visibleToViewer\(assignedTo \?\? null, cardViewer\),/,
      "the card gate must combine 'is a web-lead' with the API's own visibility rule",
    );
    assert.match(
      detail,
      /\{willRenderBattleCard \? \(/,
      "the battle card must render only when the API will actually serve it",
    );
    // NOBODY GETS NOTHING, and this is the assertion that matters.
    //
    // The card is gated on `visibleToViewer`, which accepts the assignee only,
    // while this PAGE admits collaborators too. So a collaborator can open the
    // record and be refused the card. That is survivable only because the
    // website band above renders unconditionally -- asserted in section 8. If
    // that band ever becomes conditional, this gate starts hiding the business
    // from exactly the people the comp plan pays.
    assert.match(
      detail,
      /const willRenderBattleCard = Boolean\(/,
      "the card gate must be a named, single decision -- not repeated inline",
    );
    assert.doesNotMatch(
      detail,
      /\{willRenderBattleCard \? \([\s\S]{0,4000}?\) : \(\s*<Lead/,
      "there must be no BAND alternative branch -- the unconditional band above already covers it, and a second one is the duplication that was removed",
    );

    // The card is READ, not hidden behind a click. A card a rep has to expand
    // is a card they will not open while a stranger is waiting.
    assert.match(
      detail,
      /storageKey="oasis\.pipeline\.battleCard\.collapsed"[\s\S]{0,120}?defaultCollapsed=\{false\}/,
      "the battle card must be open by default on the pipeline record",
    );

    // ─── EMBEDDED CHANGES CHROME, NEVER CONTENT ───────────────────────────
    //
    // The whole parity claim rests on this. If `embedded` ever gates a PANEL
    // rather than a wrapper class, the pipeline silently becomes a reduced
    // version of the leads tab again -- which is the exact complaint. So the
    // flag may only appear on layout wrappers and the back link.
    const card = read("components/web-leads/BattleCard.tsx");
    for (const section of [
      "Who you are calling",
      "up against",
      "<ObjectionPanel",
      "<CallOutcomeLog",
      "<BusinessFacts",
    ]) {
      assert.ok(card.includes(section), `${section} must still be in the card`);
    }
    // No panel may be conditional on `embedded`.
    assert.doesNotMatch(
      card,
      /\{\s*!?embedded\s*&&\s*<(Panel|ObjectionPanel|CallOutcomeLog|BusinessFacts|Hero)/,
      "embedded must not gate any CONTENT panel -- it exists for layout chrome only",
    );
    // It IS allowed to drop the back link, which points at the leads pool and is
    // the wrong door from the pipeline (that page has its own Back to pipeline).
    assert.match(card, /\{!embedded && <BackLink \/>\}/);
  }


  console.log("pipeline-web-lead-facts ok — the CRM board carries the business, the website and an honest score");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
