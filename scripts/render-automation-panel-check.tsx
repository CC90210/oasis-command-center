/**
 * Server-renders AutomationPanel on its own and asserts what actually reaches
 * the HTML.
 *
 * The rest of the suite proves the TABLE is correct and that the component is
 * wired in. Neither proves the component RENDERS -- a crash in the map, a bad
 * prop, an empty group, and every one of those tests still passes while a rep
 * gets a blank panel mid-call. This is the cheapest honest answer to "has
 * anybody actually looked at it", short of a browser.
 *
 *   node --import tsx scripts/render-automation-panel-check.tsx
 */

import assert from "node:assert";
// tsx compiles this file's JSX with the CLASSIC runtime, which emits
// React.createElement and needs React in scope. Without it the whole check
// dies on the first render with "React is not defined" -- which it did.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationPanel } from "../components/web-leads/AutomationPanel";
import { CAPABILITIES, isDeliverable } from "../lib/web-leads/automations";
import type { AuditResult } from "../lib/web-leads/audit";

const SCORED: AuditResult = {
  state: "scored",
  url: "https://example.com",
  measuredAt: "2026-08-25T00:00:00.000Z",
  composite: 41,
  dimensions: [
    {
      key: "conversion",
      label: "Conversion",
      score: 30,
      weight: 30,
      checks: [
        { code: "booking", label: "Online booking", points: 5, has: false },
        { code: "chat", label: "Live chat", points: 3, has: true },
      ],
      missing: ["booking"],
    },
  ],
};

/**
 * Rendered markup back to the words a rep would actually read.
 *
 * The entity decode is load-bearing, not tidiness: seven of the seventeen
 * industry names contain an ampersand, so React escapes them to `&amp;` and a
 * naive tag-strip leaves "Salons &amp; Personal Care" -- every industry-name
 * assertion in here would fail on markup that is completely correct.
 */
const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:ldquo|rdquo|quot);/g, '"')
    .replace(/&(?:rsquo|lsquo|#39);/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

// ---- 1. a scored salon renders both groups, the marker, and real copy ----
{
  const html = renderToStaticMarkup(<AutomationPanel industry="Salons & Personal Care" audit={SCORED} />);
  const text = strip(html);

  assert.match(text, /Attaches to the site we are building/, "the first group heading must render");
  assert.match(text, /Once that is running/, "the second group heading must render");
  assert.match(text, /written for salons & personal care/i, "the industry must be named to the rep");
  assert.match(text, /Not on their site/, "the audit-derived marker must render");
  assert.match(text, /book you from their phone at eleven at night/, "real card copy must reach the HTML");
  assert.match(text, /Why it lands here/, "the industry reason must be labelled");

  // The marker appears exactly as often as the audit justifies. `booking` is the
  // only absent code the salon set can key on, so one marker and no more --
  // a marker on every card would be the failure this whole feature guards.
  const markers = (html.match(/Not on their site/g) || []).length;
  assert.equal(markers, 1, `expected exactly one absence marker, rendered ${markers}`);

  // Nothing held back for review may appear in the markup.
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    if (isDeliverable(cap)) continue;
    assert.ok(!text.includes(cap.says), `unverified capability "${id}" rendered to a rep`);
  }
}

// ---- 2. the three non-scored states render, and accuse nobody of anything ----
for (const audit of [
  { state: "no_website" } as AuditResult,
  { state: "not_scored" } as AuditResult,
  { state: "unreachable", reason: "timeout", lastAttemptedAt: "2026-08-25T00:00:00.000Z" } as AuditResult,
]) {
  const html = renderToStaticMarkup(<AutomationPanel industry="Trades & Contractors" audit={audit} />);
  const text = strip(html);
  assert.match(text, /Attaches to the site we are building/, `${audit.state}: the panel must still render`);
  assert.match(text, /rings four trades in ten minutes/, `${audit.state}: real trade copy must render`);
  assert.ok(
    !text.includes("Not on their site"),
    `${audit.state}: nothing was measured, so nothing may be marked missing`,
  );
}

// ---- 3. a lead with no industry gets the fallback, and is told so ----
{
  const html = renderToStaticMarkup(<AutomationPanel industry={null} audit={SCORED} />);
  const text = strip(html);
  assert.match(text, /have not written a set for this business/i, "the fallback must say so plainly");
  assert.match(text, /Attaches to the site we are building/, "the fallback panel must still be full");
}

// ---- 4. every industry renders without throwing ----
{
  const INDUSTRIES = [
    "Salons & Personal Care", "Auto Services", "Food Retail", "Restaurants & Bars",
    "Health & Medical", "Education & Childcare", "Apparel & Accessories", "Electronics & Tech",
    "Home & Hardware", "Home Furnishings", "Sports & Outdoors", "Local Services",
    "Pet Services", "Travel", "Specialty Retail", "Trades & Contractors", "Professional Services",
  ];
  for (const industry of INDUSTRIES) {
    const html = renderToStaticMarkup(<AutomationPanel industry={industry} audit={SCORED} />);
    assert.ok(html.length > 2000, `${industry}: rendered suspiciously little markup (${html.length} chars)`);
    assert.ok(html.includes("Once that is running"), `${industry}: second group did not render`);
  }
}

console.log("automation-panel render check ok");
