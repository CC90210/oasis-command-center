/**
 * tests/site-scan-score.test.ts — lib/site-scan/score.ts and narrative.ts: deterministic, explained,
 * and the fixes are the biggest missing points first.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-score.test.ts
 */
import assert from "node:assert/strict";
import { claimHeading, scoreFacts } from "../lib/site-scan/score";
import { baseNarrative, placePhrase, sourcesLine } from "../lib/site-scan/narrative";
import { FACTS_SCHEMA, type ScanFacts, type SiteSignals } from "../lib/site-scan/types";
import type { CheckKey, CheckStatus, SiteCheck } from "../lib/ai-audit/site-checks";

function check(key: CheckKey, status: CheckStatus): SiteCheck {
  return { key, status, detail: `${key} ${status}`, found: [], evidence: null };
}

const signals: SiteSignals = {
  title: "Acme Plumbing", meta_description: "Plumbers in Laval", h1: ["24/7 plumbers"], og_site_name: null, language: "en",
  business_name: "Acme Plumbing", tagline: "24/7 plumbers", phones: ["514 555 0100"], emails: [], localities: ["Laval"],
  services: ["Drains", "Heating"], pricing_mentioned: false, booking_tools: [], forms_count: 0, chat_tools: [], analytics: [],
  socials: { facebook: "https://facebook.com/acme" }, schema_types: [], copyright_year: 2020, blog: { found: false, latest_date: null },
  images_total: 10, images_missing_alt: 8, internal_links: 12, external_links: 2, cta_phrases: [], keywords: [{ term: "plumbing", count: 5 }],
  word_count: 400, text_excerpt: "plumbing",
};

function facts(overrides: Partial<ScanFacts> = {}, checks: SiteCheck[] = []): ScanFacts {
  return {
    schema: FACTS_SCHEMA, domain: "acme.example", start_url: "https://acme.example/", final_url: "https://acme.example/", read_at: "2026-11-12T00:00:00.000Z",
    site: { unread: null, pages_read: 3, notes: [], https_served: true, response_ms: 900, html_kb: 60 },
    checks, pagespeed: null, signals, ...overrides,
  };
}

// A weak site: no call link, no form, no booking, slow PageSpeed, stale footer.
const weak = facts(
  { pagespeed: { ok: true, url: "https://acme.example/", final_url: null, strategy: "mobile", scores: { performance: 38, accessibility: 80, seo: 72, best_practices: 90 }, timings: { lcp_ms: 5200, fcp_ms: 2100, tbt_ms: 600, cls: 0.2, speed_index_ms: 6000 }, fetched_at: "2026-11-12T00:00:00.000Z", lighthouse_version: "12" } },
  [check("https", "yes"), check("mobile_viewport", "yes"), check("title", "yes"), check("meta_description", "yes"), check("click_to_call", "no"), check("email_link", "no"), check("contact_form", "no"), check("online_booking", "no"), check("live_chat", "no"), check("analytics", "no"), check("platform", "yes"), check("structured_data", "no"), check("social_links", "yes"), check("sitemap", "no"), check("html_size", "yes"), check("response_time", "yes")],
);
const w = scoreFacts(weak);
assert.equal(w.pillars.length, 5);
assert.equal(w.pillars.reduce((a, p) => a + p.weight, 0), 100);
assert.ok(w.total >= 0 && w.total <= 100);
assert.ok(w.total < 50, `weak site scores low: ${w.total}`);
assert.equal(w.pillars.find((p) => p.key === "conversion")!.score, 0, "nothing to act on");
assert.equal(w.fixes.length, 3);
// Mobile speed is 60 of a 20-point pillar (12 points); booking is 30 of a 30-point pillar (9 points).
assert.equal(w.fixes[0].key, "mobile_speed", "the biggest missing points come first");
assert.ok(w.fixes.some((f) => f.key === "online_booking"), "booking is in the top three");
assert.ok(w.fixes.every((f) => f.impact > 0 && f.automation && f.why));
assert.ok(w.fixes.map((f) => f.impact).every((v, i, a) => i === 0 || a[i - 1] >= v), "fixes sorted by impact");
assert.ok(w.pillars.find((p) => p.key === "speed")!.detail.includes("PageSpeed 38"));

// Determinism.
assert.deepEqual(scoreFacts(weak), w);

// A strong site: everything present, fast.
const strong = facts(
  {
    signals: { ...signals, cta_phrases: ["book now"], chat_tools: ["Crisp"], analytics: ["Google Analytics"], emails: ["a@b.c"], copyright_year: 2026, blog: { found: true, latest_date: "2026-10-01" }, socials: { facebook: "x", instagram: "y" }, images_missing_alt: 1 },
    pagespeed: { ok: true, url: "https://acme.example/", final_url: null, strategy: "mobile", scores: { performance: 92, accessibility: 95, seo: 100, best_practices: 100 }, timings: { lcp_ms: 1200, fcp_ms: 800, tbt_ms: 50, cls: 0.01, speed_index_ms: 1500 }, fetched_at: "2026-11-12T00:00:00.000Z", lighthouse_version: "12" },
  },
  [check("https", "yes"), check("mobile_viewport", "yes"), check("title", "yes"), check("meta_description", "yes"), check("click_to_call", "yes"), check("email_link", "yes"), check("contact_form", "yes"), check("online_booking", "yes"), check("live_chat", "yes"), check("analytics", "yes"), check("platform", "yes"), check("structured_data", "yes"), check("social_links", "yes"), check("sitemap", "yes"), check("html_size", "yes"), check("response_time", "yes")],
);
const st = scoreFacts(strong);
assert.ok(st.total >= 95, `strong site scores high: ${st.total}`);
assert.equal(st.fixes.length, 0);

// Unknown checks neither earn nor lose: the pillar is scored over what could be read.
const unknowns = facts({}, [check("https", "yes"), check("click_to_call", "unknown"), check("contact_form", "unknown"), check("online_booking", "unknown")]);
const u = scoreFacts(unknowns);
assert.ok(u.pillars.find((p) => p.key === "conversion")!.score < 100);

// An unread site still scores (all unknown), and the narrative says so.
const unread = facts({ signals: null, site: { unread: "no_answer", pages_read: 0, notes: ["no answer"], https_served: false, response_ms: null, html_kb: null } }, []);
const ur = scoreFacts(unread);
const un = baseNarrative(unread, ur);
assert.ok(un.what_you_sell.includes("could not be read"));

// The base narrative is built from facts only.
const n = baseNarrative(weak, w);
assert.equal(n.schema, "site_scan/narrative/v1");
assert.equal(n.source, "template");
assert.ok(n.what_you_sell.includes("Acme Plumbing") && n.what_you_sell.includes("Laval") && n.what_you_sell.includes("Drains"));
assert.ok(n.who_buys.includes("No prices are shown"));
assert.ok(n.fixes_intro.includes(`${w.total}/100`));
assert.equal(n.email, null);

// A tagline that ends its own sentence is not given a second stop.
const stopped = baseNarrative(facts({ signals: { ...signals, tagline: "Your local garden centre for over 75 years." } }), w);
assert.ok(stopped.what_you_sell.includes(`"Your local garden centre for over 75 years." `) && !stopped.what_you_sell.includes(`years.".`), stopped.what_you_sell);
assert.ok(n.what_you_sell.includes(`"24/7 plumbers".`), "a tagline with no stop gets one");

// Attribution is never guessed: the engine's records when present; the directory only when the
// matches carry no other source (the pre-2.0 engine); otherwise a neutral line.
const enr = (competitors: Array<Record<string, unknown>>, sources?: Array<{ key: string; label: string; note: string }>) =>
  ({ schema: "site_scan/enrich/v1", engine: { embedder: "x", version: "2" }, category: null, keywords: [], segments: [], competitors, prospects: [], email_auth: null, notes: [], sources }) as unknown as Parameters<typeof sourcesLine>[0];
assert.equal(sourcesLine(enr([{ name: "A", source: "overture" }], [{ key: "overture", label: "Overture Maps places", note: "Places: Overture Maps Foundation." }])), "From Overture Maps places. Places: Overture Maps Foundation.");
assert.equal(sourcesLine(enr([{ name: "A" }])), "From OASIS’s own business directory.");
assert.equal(sourcesLine(enr([{ name: "A", source: "overture" }])), "From public business listings.");

// A region code qualifies its town; it is never a second town ("in Hamilton and ON").
assert.equal(placePhrase(["Hamilton", "ON"]), " in Hamilton, ON");
assert.equal(placePhrase(["Laval", "Montreal", "QC"]), " in Laval and Montreal");
assert.equal(placePhrase(["QC"]), " in QC");
assert.equal(placePhrase([]), "");

// No footer year read is unknown, never "Footer year is stale" (live scan 2026-11-12: a Squarespace
// site with no year was told its year was years behind).
const yearless = scoreFacts(facts({ signals: { ...signals, copyright_year: null } }, weak.checks));
assert.ok(!yearless.pillars.find((p) => p.key === "trust")?.detail.includes("Footer year is stale"), "no year is not a stale year");
assert.ok(!yearless.fixes.some((f) => f.key === "copyright"));
assert.ok(w.pillars.find((p) => p.key === "trust")?.detail.includes("Footer year is stale"), "a 2020 year still is");

// The claim heading promises only the fixes the report priced.
assert.equal(claimHeading(3), "Get the three fixes priced by a founder.");
assert.equal(claimHeading(2), "Get the two fixes priced by a founder.");
assert.equal(claimHeading(1), "Get the fix priced by a founder.");
assert.ok(!/fix/.test(claimHeading(0)));

console.log("site-scan-score: ok");
