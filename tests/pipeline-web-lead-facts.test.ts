/**
 * The CRM board shows the business, not just the contact.
 *
 * Adon, 2026-08-25: "you can see [it] on the leads tab but you should also be
 * able to click and view the website as well as see all of the leads
 * information, just like on the leads tab, but on the pipeline tab, which is
 * our CRM."
 *
 * Every business fact was already on the lead row and simply never read by
 * the pipeline's row model; that wiring is what this file pins.
 *
 * 2026-10-28: the Prospects surface (/web-leads) retired, and with it the
 * board's website-score join (lib/web-leads/attach-scores.ts) and the battle
 * card on the lead page. The lead's own website facts stay on the row and in
 * the lead page's website band; the last section proves the retired pieces
 * stay gone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

function run() {
  // ---------------------------------------------------------------------------
  // 1. THE BOARD ACTUALLY READS THE BUSINESS FIELDS.
  //
  // Source-matched because oasisRowModel is module-private to a client
  // component. This proves the fields are wired at all, which is the thing that
  // was missing.
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
    // It was, and the moment it gained its own "View site" link that became an
    // anchor inside an anchor -- invalid HTML that browsers do not render as
    // written (the parser closes the outer <a> early and the row comes apart).
    // React emits it happily and nothing throws. The stretched-link overlay is
    // what replaced it.
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
  // 2. THE LEAD PAGE'S WEBSITE BAND RENDERS FOR EVERY VIEWER.
  //
  // `LeadWebsiteAuditBand` carries the website, the industry, the condition and
  // the findings. It is not gated on anything, so no viewer who may open a
  // lead is ever left without its business details.
  // ---------------------------------------------------------------------------
  {
    const detail = read("app/pipeline/[id]/page.tsx");
    assert.match(
      detail,
      /<LeadWebsiteAuditBand data=\{activeRecord\.data\} \/>/,
      "the website band must render for EVERY viewer",
    );
    assert.doesNotMatch(
      detail,
      /\{[^}]*&& <LeadWebsiteAuditBand/,
      "the website band must not be gated -- gating it could leave a collaborator with nothing",
    );
  }

  // ---------------------------------------------------------------------------
  // 3. THE RETIRED PIECES STAY GONE (2026-10-28).
  //
  // The score join was 2 extra database round trips on every board render, and
  // the battle card fetched routes that now answer 404.
  // ---------------------------------------------------------------------------
  {
    const page = read("app/pipeline/page.tsx");
    const view = read("components/manifest/LeadPipelineView.tsx");
    const detail = read("app/pipeline/[id]/page.tsx");
    assert.doesNotMatch(page, /attachWebsiteScores|lib\/web-leads/, "the board must not join website scores any more");
    assert.doesNotMatch(view, /\/web-leads|derived_website_score|isWebLead/, "no row may link to the retired battle card or render a score");
    assert.doesNotMatch(detail, /BattleCard|lib\/web-leads|components\/web-leads/, "the lead page must not embed the retired battle card");
  }

  console.log("pipeline-web-lead-facts ok — the CRM board carries the business and the website");
}

run();
