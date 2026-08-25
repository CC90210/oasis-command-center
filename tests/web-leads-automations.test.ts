import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITIES,
  INDUSTRY_AUTOMATIONS,
  GENERAL_KEY,
  isDeliverable,
  selectAutomations,
} from "../lib/web-leads/automations";
import { REMEDIES } from "../lib/web-leads/remedies";
import type { AuditResult } from "../lib/web-leads/audit";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// THE TAXONOMY IS CLOSED, AND THAT IS THE WHOLE ARGUMENT FOR DOING THIS PER
// INDUSTRY. Every lead is stamped with one of these at ingest by JARVIS's
// INDUSTRY_MAP (services/leadgen/lib/sources/osm-source.js). Seventeen
// hand-written sets therefore cover every lead we hold and every lead we will
// scrape, which is why no copy on this surface is generated per lead.
//
// This list is duplicated here ON PURPOSE rather than imported: JARVIS is a
// different repo with no build-time link to oasis, so the only way a rename
// over there is caught over here is a test that fails loudly when the two
// drift. A missing industry is a rep opening a battle card mid-call to an
// empty panel.
// ---------------------------------------------------------------------------
const INDUSTRIES = [
  "Salons & Personal Care",
  "Auto Services",
  "Food Retail",
  "Restaurants & Bars",
  "Health & Medical",
  "Education & Childcare",
  "Apparel & Accessories",
  "Electronics & Tech",
  "Home & Hardware",
  "Home Furnishings",
  "Sports & Outdoors",
  "Local Services",
  "Pet Services",
  "Travel",
  "Specialty Retail",
  "Trades & Contractors",
  "Professional Services",
];

for (const industry of INDUSTRIES) {
  assert.ok(
    INDUSTRY_AUTOMATIONS[industry],
    `no automations written for "${industry}" -- every industry JARVIS can stamp on a lead must have a set`,
  );
}
assert.ok(INDUSTRY_AUTOMATIONS[GENERAL_KEY], "the fallback set must exist");
assert.equal(
  Object.keys(INDUSTRY_AUTOMATIONS).length,
  INDUSTRIES.length + 1,
  "an industry key exists here that JARVIS never stamps on a lead, so nothing would ever render it",
);

// ---------------------------------------------------------------------------
// Structure: every industry entry points at a real capability, once.
// ---------------------------------------------------------------------------
for (const [industry, entries] of Object.entries(INDUSTRY_AUTOMATIONS)) {
  const seen = new Set<string>();
  for (const e of entries) {
    assert.ok(CAPABILITIES[e.id], `${industry}: "${e.id}" is not a capability we have described`);
    assert.ok(!seen.has(e.id), `${industry}: "${e.id}" listed twice`);
    seen.add(e.id);
  }

  // A panel with two cards on it is not a menu a rep can work from, and both
  // groups must have something in them or the second heading renders empty.
  const deliverable = entries.filter((e) => isDeliverable(CAPABILITIES[e.id]));
  const attached = deliverable.filter((e) => CAPABILITIES[e.id].group === "attached");
  const later = deliverable.filter((e) => CAPABILITIES[e.id].group === "later");
  assert.ok(attached.length >= 3, `${industry}: only ${attached.length} deliverable site-attached cards`);
  assert.ok(later.length >= 1, `${industry}: no deliverable card in the "later" group`);
}

// ---------------------------------------------------------------------------
// EVERY MEASUREMENT CLAIM POINTS AT A CHECK WE ACTUALLY RUN. `provenBy` is what
// turns a generic card into "they do not have this" on a live call. A code that
// does not exist in the model would mark a card as missing forever, which is a
// rep telling a stranger their site lacks something nothing ever looked for.
// ---------------------------------------------------------------------------
for (const [id, cap] of Object.entries(CAPABILITIES)) {
  for (const code of cap.provenBy) {
    assert.ok(REMEDIES[code], `${id}: provenBy "${code}" is not a check in the quality model`);
  }
}

// ---------------------------------------------------------------------------
// COPY HYGIENE. Everything below is read aloud to a stranger on a live call.
// ---------------------------------------------------------------------------
const spoken: { where: string; text: string }[] = [];
for (const [id, cap] of Object.entries(CAPABILITIES)) {
  spoken.push({ where: `CAPABILITIES.${id}.says`, text: cap.says });
  spoken.push({ where: `CAPABILITIES.${id}.gets`, text: cap.gets });
}
for (const [industry, entries] of Object.entries(INDUSTRY_AUTOMATIONS)) {
  for (const e of entries) {
    spoken.push({ where: `${industry}/${e.id}.why`, text: e.why });
    spoken.push({ where: `${industry}/${e.id}.answers`, text: e.answers });
  }
}

// House rule for anything customer-facing.
{
  const bad = spoken.filter((s) => s.text.includes("—"));
  assert.deepEqual(bad.map((b) => b.where), [], "em dashes are banned in customer-facing copy");
}

// THE REP CARD SAYS: "NEVER SAY -- anything about AI on call one."
// (OASIS_UNDENIABLE_OFFER_STRATEGY.md section 10.) This panel is a call-one
// surface, so the rule lands here as a test rather than as a note somebody
// reads once. Every card describes behaviour an owner recognises instead of
// the technology under it, which is also how remedies.ts is written.
{
  const aiWords = /\bAI\b|artificial intelligence|chatbot|\bbots?\b|machine learning|\bLLM\b|\bGPT\b|agentic|algorithm/i;
  const bad = spoken.filter((s) => aiWords.test(s.text));
  assert.deepEqual(bad.map((b) => b.where), [], "no card may name the technology; describe what the owner gets");
}

// NO NUMBER A REP SAYS OUT LOUD WITHOUT ADON'S SIGN-OFF. No web-dev price
// exists anywhere in the Oasis codebase or business context, and the strategy
// doc that recommends one is explicit that it is a recommendation, not a
// decision. A price on a card is a rep quoting it.
{
  const money = /\$|\bCA\s*\$|\b\d+\s*(?:\/|per\s+)\s*(?:mo\b|month|week|year)|\bdollars?\b/i;
  const bad = spoken.filter((s) => money.test(s.text));
  assert.deepEqual(bad.map((b) => b.where), [], "no price may appear on a card");
}

// A rep says these to a plumber, not to an engineer.
{
  const jargon = /viewport|CTA\b|semantic|schema\.org|DOM\b|render-block|LCP|TTFB|API\b|webhook|CRM\b|SaaS|middleware|endpoint|integrat/i;
  const bad = spoken.filter((s) => jargon.test(s.text));
  assert.deepEqual(bad.map((b) => b.where), [], "jargon in customer-facing copy");
}

// Stubs are how a table like this rots: an industry gets added, the shape is
// filled in, and nobody notices the sentences say nothing.
for (const s of spoken) {
  assert.ok(s.text.trim().length >= 30, `${s.where}: too short to be real copy`);
}

// ---------------------------------------------------------------------------
// THE COPY IS ACTUALLY PER-INDUSTRY. This is the assertion that makes the
// feature what Adon asked for rather than one generic list rendered seventeen
// times: the reason a card matters to a hair salon cannot be the same sentence
// as the reason it matters to a plumber. Duplicated `why` text is the exact
// shape a stubbed-out industry takes, and it passes every other check here.
// ---------------------------------------------------------------------------
{
  const byText = new Map<string, string[]>();
  for (const [industry, entries] of Object.entries(INDUSTRY_AUTOMATIONS)) {
    for (const e of entries) {
      const key = e.why.trim().toLowerCase();
      byText.set(key, [...(byText.get(key) || []), `${industry}/${e.id}`]);
    }
  }
  const dupes = [...byText.values()].filter((v) => v.length > 1);
  assert.deepEqual(dupes, [], `the same reason is reused across industries: ${JSON.stringify(dupes)}`);
}

// ---------------------------------------------------------------------------
// UNVERIFIED CAPABILITIES NEVER REACH A REP. Anything sourced "inferred" is
// something APEX thought Oasis could plausibly build, not something anyone has
// confirmed we deliver. It stays in the table so Adon and Cece can review and
// clear it, and it must not render until they do -- a rep offering a build we
// cannot ship is the same failure as a fabricated measurement, one step later.
// ---------------------------------------------------------------------------
const SCORED: AuditResult = {
  state: "scored",
  url: "https://example.com",
  measuredAt: "2026-08-25T00:00:00.000Z",
  composite: 40,
  dimensions: [
    {
      key: "conversion",
      label: "Conversion",
      score: 30,
      weight: 30,
      checks: [
        { code: "booking", label: "Online booking", points: 5, has: false },
        { code: "chat", label: "Live chat", points: 3, has: true },
        { code: "contact_form", label: "Contact form", points: 5, has: true },
        { code: "multi_route", label: "Multiple contact routes", points: 3, has: true },
      ],
      missing: ["booking"],
    },
  ],
};

{
  const inferred = Object.entries(CAPABILITIES).filter(([, c]) => c.source === "inferred");
  assert.ok(inferred.length >= 1, "expected at least one capability held back for review");
  const inferredIds = new Set(inferred.map(([id]) => id));

  for (const industry of [...INDUSTRIES, GENERAL_KEY]) {
    const sel = selectAutomations(industry, SCORED);
    for (const card of [...sel.attached, ...sel.later]) {
      assert.ok(
        !inferredIds.has(card.id),
        `${industry}: unverified capability "${card.id}" reached the panel`,
      );
      assert.ok(isDeliverable(CAPABILITIES[card.id]), `${industry}: "${card.id}" is not cleared to render`);
    }
    assert.ok(sel.attached.length >= 3, `${industry}: panel would render thin`);
    assert.ok(sel.later.length >= 1, `${industry}: second group would render empty`);
  }
}

// ---------------------------------------------------------------------------
// A NULL OR UNRECOGNISED INDUSTRY GETS THE GENERAL SET, NEVER AN EMPTY PANEL.
// `industry` is `string | null` on WebLead and JARVIS's long-tail buckets can
// produce a value this table has not seen. A rep mid-call gets the general set
// and never knows; a blank panel is the failure.
// ---------------------------------------------------------------------------
for (const missing of [null, "", "   ", "Underwater Basket Weaving"]) {
  const sel = selectAutomations(missing, SCORED);
  assert.ok(sel.attached.length >= 3, `${JSON.stringify(missing)}: fallback panel is thin`);
  assert.equal(sel.isFallback, true, `${JSON.stringify(missing)}: must be flagged as the fallback set`);
}
assert.equal(selectAutomations("Pet Services", SCORED).isFallback, false, "a known industry is not a fallback");

// Industry matching must not hinge on incidental whitespace or case: the value
// travels from a JSON blob in Turso, not from a typed enum.
assert.equal(selectAutomations("  pet services  ", SCORED).isFallback, false, "industry match must be forgiving");

// ---------------------------------------------------------------------------
// WHAT THIS SITE IS MISSING SORTS FIRST. The per-lead relevance in this feature
// comes entirely from the audit we already ran -- no copy is generated per
// lead. `booking` is absent in SCORED above and `chat` is present, so the
// booking card must outrank the chat card and must be the one marked.
// ---------------------------------------------------------------------------
// The fixture below is chosen so DECLARATION ORDER AND MISSING-FIRST DISAGREE,
// which is the only way this assertion means anything. An earlier version of
// this test compared booking against chat in the salon set -- but booking is
// hand-authored FIRST there, so it outranked chat whether the audit was
// consulted or not, and deleting the entire ranking function left the test
// green. Proved by planting exactly that deletion (2026-08-25).
//
// `review_requests` is declared FIFTH for salons and `online_booking` FIRST.
// Marking reviews absent and booking present therefore forces the two orders
// apart: only a selector that actually reads the audit puts reviews on top.
const SCORED_REVIEWS_MISSING: AuditResult = {
  state: "scored",
  url: "https://example.com",
  measuredAt: "2026-08-25T00:00:00.000Z",
  composite: 55,
  dimensions: [
    {
      key: "conversion",
      label: "Conversion",
      score: 60,
      weight: 30,
      checks: [{ code: "booking", label: "Online booking", points: 5, has: true }],
      missing: [],
    },
    {
      key: "trust",
      label: "Trust",
      score: 20,
      weight: 20,
      checks: [
        { code: "testimonials", label: "Testimonials", points: 4, has: false },
        { code: "review_platform", label: "Review platform", points: 4, has: false },
      ],
      missing: ["testimonials", "review_platform"],
    },
  ],
};

{
  const sel = selectAutomations("Salons & Personal Care", SCORED_REVIEWS_MISSING);
  const ids = sel.attached.map((c) => c.id);
  const iReviews = ids.indexOf("review_requests");
  const iBooking = ids.indexOf("online_booking");
  assert.ok(iReviews >= 0 && iBooking >= 0, "expected both reviews and booking in the salon set");
  assert.ok(
    iReviews < iBooking,
    "a capability this site lacks must outrank one it already has, even when the hand-authored order says otherwise",
  );
  assert.equal(sel.attached[iReviews].missingHere, true, "reviews are absent from this site and must be marked");
  assert.equal(sel.attached[iBooking].missingHere, false, "booking is present on this site and must not be marked");

  // Among cards with the same missing status, the hand-authored priority is
  // what survives. Adon and Cece set that order; the audit only promotes.
  const present = sel.attached.filter((c) => !c.missingHere).map((c) => c.id);
  const declared = INDUSTRY_AUTOMATIONS["Salons & Personal Care"]
    .filter((e) => present.includes(e.id))
    .map((e) => e.id);
  assert.deepEqual(present, declared, "cards that are not promoted must keep their hand-authored order");
}

{
  const sel = selectAutomations("Salons & Personal Care", SCORED);
  const booking = sel.attached.find((c) => c.id === "online_booking");
  const chat = sel.attached.find((c) => c.id === "web_chat");
  assert.equal(booking?.missingHere, true, "booking is absent from this site and must be marked");
  assert.equal(chat?.missingHere, false, "chat is present on this site and must not be marked");
}

// The three non-scored states carry no checks. Nothing may throw, and nothing
// may be marked missing -- claiming a site lacks booking when we never reached
// the site is a fabricated finding, which is the worst thing this system can do.
for (const audit of [
  { state: "no_website" } as AuditResult,
  { state: "not_scored" } as AuditResult,
  { state: "unreachable", reason: "timeout", lastAttemptedAt: "2026-08-25T00:00:00.000Z" } as AuditResult,
]) {
  const sel = selectAutomations("Trades & Contractors", audit);
  assert.ok(sel.attached.length >= 3, `${audit.state}: panel must still render`);
  assert.deepEqual(
    sel.attached.filter((c) => c.missingHere).map((c) => c.id),
    [],
    `${audit.state}: nothing may be marked missing when nothing was measured`,
  );
}

// ---------------------------------------------------------------------------
// The panel is wired in, renders both groups, and carries the honesty rules.
// ---------------------------------------------------------------------------
{
  const panel = read("components/web-leads/AutomationPanel.tsx");
  assert.match(panel, /selectAutomations\(/, "the panel must select through the audit-aware helper");
  assert.doesNotMatch(panel, /\$\d/, "no price may be hardcoded into the panel");
  // Both group headings exist, so a rep can tell what is part of the build
  // from what is a later conversation.
  assert.match(panel, /attached/, "the panel must render the site-attached group");
  assert.match(panel, /later/, "the panel must render the later group");

  const card = read("components/web-leads/BattleCard.tsx");
  assert.match(card, /<AutomationPanel/, "the battle card must render the panel");
  assert.match(card, /import \{ AutomationPanel \} from "\.\/AutomationPanel"/, "the battle card must import the panel");
  // Placement is load-bearing, not cosmetic. Adon's framing is the save when
  // the website pitch is dying, and the upsell ladder says do not lead with
  // this. Rendering it above the objections turns a fallback into an opener.
  assert.ok(
    card.indexOf("<ObjectionPanel") < card.indexOf("<AutomationPanel"),
    "the automations panel must sit BELOW the objections, it is the save and not the opener",
  );
}

// The colour ban that governs every other surface in this feature must name
// this file too. Asserted from the guards test's own source so the two cannot
// drift: adding the panel without adding it there is how a red card ends up in
// front of a rep.
assert.match(
  read("tests/web-leads-guards.test.ts"),
  /components\/web-leads\/AutomationPanel\.tsx/,
  "AutomationPanel must be listed in the colour-ban loop in web-leads-guards.test.ts",
);

console.log("web-leads-automations ok");
