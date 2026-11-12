/**
 * tests/site-scan-enrich-parse.test.ts — the runner's answer is checked field by field with hard caps
 * (lib/site-scan/enrich-job.ts). Nothing a runner says reaches a visitor unchecked.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-enrich-parse.test.ts
 */
import assert from "node:assert/strict";
import { parseEmbedding, parseEnrich, parseEnrichReport, parseNarrative } from "../lib/site-scan/enrich-job";

const good = {
  schema: "site_scan/enrich/v1",
  engine: { embedder: "fastembed:BAAI/bge-small-en-v1.5", version: "1.0.0" },
  category: { key: "plumbing_hvac", label: "Plumbing, heating and HVAC", confidence: 0.81 },
  keywords: ["plumbing", "heating", "drain"],
  segments: [
    { key: "homeowners", label: "Homeowners", fit: 88.4, why: "They call the first name they can reach." },
    { key: "property_managers", label: "Property managers", fit: 84, why: "Dispatch without chasing." },
  ],
  competitors: [{ name: "Plomberie V.I.P.", domain: "https://www.plomberievip.com/x", locality: "Montreal" }],
  prospects: [{ name: "Gestion Nord", locality: "Montreal", region: "QC", domain: "gin.example", category_label: "Property managers", why: "A property manager in Montreal." }],
  email_auth: { mx: true, spf: false, dmarc: null },
  notes: ["No SPF record."],
};

const e = parseEnrich(good);
assert.ok(e);
assert.equal(e!.category!.key, "plumbing_hvac");
assert.equal(e!.segments[0].fit, 88, "fit is rounded");
assert.equal(e!.competitors[0].domain, "plomberievip.com", "domains are normalised");
assert.equal(e!.prospects[0].category_label, "Property managers");
assert.deepEqual(e!.email_auth, { mx: true, spf: false, dmarc: null });

// Wrong schema, missing fields, out-of-range values are refused or dropped.
assert.equal(parseEnrich({ ...good, schema: "site_scan/enrich/v0" }), null);
assert.equal(parseEnrich("nope"), null);
const sloppy = parseEnrich({ ...good, segments: [{ key: "x", label: "X", fit: 140, why: "too high" }, { key: "y", label: "Y", fit: 50 }], competitors: [{ name: "" }, { name: "Ok", domain: "not a domain" }], prospects: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, category_label: "C", why: "w" })) });
assert.ok(sloppy);
assert.equal(sloppy!.segments.length, 0, "a fit over 100 and a missing why are both dropped");
assert.equal(sloppy!.competitors.length, 1);
assert.equal(sloppy!.competitors[0].domain, null);
assert.equal(sloppy!.prospects.length, 8, "prospects are capped at 8");

// Control characters and length caps.
const long = parseEnrich({ ...good, notes: ["a\u0000b", "x".repeat(1000)], keywords: Array.from({ length: 50 }, (_, i) => `k${i}`) });
assert.equal(long!.notes[0], "ab");
assert.equal(long!.notes[1].length, 200);
assert.equal(long!.keywords.length, 20);

// Narrative.
const n = parseNarrative({ schema: "site_scan/narrative/v1", source: "template", what_you_sell: "A", who_buys: "B", fixes_intro: "C", competitors_note: null, email: { to: "Gestion Nord", subject: "Hi", body: "Line 1\n\nLine 2" } });
assert.ok(n && n.email && n.email.body === "Line 1\n\nLine 2", "email bodies keep their line breaks");
assert.equal(parseNarrative({ schema: "site_scan/narrative/v1", what_you_sell: "A" }), null, "all three paragraphs are required");
assert.equal(parseNarrative({ ...good, schema: "site_scan/narrative/v1", source: "model", what_you_sell: "A", who_buys: "B", fixes_intro: "C" })!.source, "model");

// Embeddings.
assert.deepEqual(parseEmbedding([0.123456789, -1]), [0.12346, -1]);
assert.equal(parseEmbedding([]), null);
assert.equal(parseEmbedding(["a"]), null);
assert.equal(parseEmbedding(new Array(1025).fill(0.1)), null);

// The whole report.
assert.equal(parseEnrichReport({ enrich: good }).ok, true);
const bad = parseEnrichReport({ enrich: good, narrative: { schema: "x" } });
assert.ok(!bad.ok && bad.field === "narrative");
const badEmb = parseEnrichReport({ enrich: good, embedding: "x" });
assert.ok(!badEmb.ok && badEmb.field === "embedding");
assert.ok(!parseEnrichReport({}).ok);

console.log("site-scan-enrich-parse: ok");
