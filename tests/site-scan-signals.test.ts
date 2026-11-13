/**
 * tests/site-scan-signals.test.ts — lib/site-scan/signals.ts on fixture HTML, no network.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-signals.test.ts
 */
import assert from "node:assert/strict";
import { extractSignals, tidyName } from "../lib/site-scan/signals";
import { runSiteChecks, type PageSnapshot } from "../lib/ai-audit/site-checks";

function page(url: string, html: string, status = 200): PageSnapshot {
  return { url, finalUrl: url, status, contentType: "text/html", html, bytes: html.length, ms: 300, truncated: false };
}

const HOME = `<!doctype html><html lang="en-CA"><head>
<title>JW Plumbing &amp; Heating | Emergency plumber in Montreal</title>
<meta name="description" content="Plumbing, heating and drain repairs across Montreal and Laval since 1985.">
<meta property="og:site_name" content="JW Plumbing &amp; Heating">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"JW Plumbing & Heating","address":{"@type":"PostalAddress","addressLocality":"Montréal","addressRegion":"QC"},"makesOffer":[{"@type":"Offer","itemOffered":{"@type":"Service","name":"Drain cleaning"}}]}</script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-ABCDEF1234"></script>
</head><body>
<nav><a href="/services">Services</a><a href="/pricing">Pricing</a><a href="/contact">Contact</a><a href="/blog">Blog</a></nav>
<h1>Licensed plumbers, 24/7 emergency service</h1>
<p>Call us now at (514) 555-0123 or email help@jwph.example. Get a free quote today.</p>
<img src="/a.jpg" alt="Van"><img src="/b.jpg"><img src="/c.jpg">
<a href="https://www.facebook.com/jwph">Facebook</a><a href="https://instagram.com/jwph">Instagram</a>
<a href="https://calendly.com/jwph/visit">Book online</a>
<form action="/contact"><input name="email"></form>
<footer>© 2019-2024 JW Plumbing &amp; Heating. Serving Montreal and Laval.</footer>
</body></html>`;

const SERVICES = `<html><head><title>Services | JW</title></head><body><h1>Our services</h1>
<ul><li><a href="/services/water-heaters">Water heater installation</a></li><li><a href="/services/heating">Heating repair</a></li></ul>
<p>Prices start at $120 per visit.</p><script src="https://static.hotjar.com/c/hotjar-1.js"></script></body></html>`;

const BLOG = `<html><head><title>Blog</title></head><body><article><time>2026-03-04</time><h2>Frozen pipes</h2></article><article><time>2025-11-20</time></article></body></html>`;

const s = extractSignals({
  domain: "jwph.example",
  pages: [page("https://jwph.example/", HOME), page("https://jwph.example/services", SERVICES), page("https://jwph.example/blog", BLOG), page("https://jwph.example/404", "<html></html>", 404)],
});

assert.equal(s.business_name, "JW Plumbing & Heating", "og:site_name wins as the business name");
assert.equal(s.title, "JW Plumbing & Heating | Emergency plumber in Montreal");
assert.equal(s.meta_description, "Plumbing, heating and drain repairs across Montreal and Laval since 1985.");
assert.deepEqual(s.h1.slice(0, 2), ["Licensed plumbers, 24/7 emergency service", "Our services"]);
assert.equal(s.tagline, "Licensed plumbers, 24/7 emergency service");
assert.equal(s.language, "en-CA");
assert.deepEqual(s.phones, ["(514) 555-0123"]);
assert.deepEqual(s.emails, ["help@jwph.example"]);
assert.ok(s.localities.includes("Montreal") && s.localities.includes("Laval"), `localities: ${s.localities.join(",")}`);
assert.ok(s.localities.includes("Montréal") || s.localities.includes("Quebec") || s.localities.includes("QC") || s.localities.length >= 2, "schema address adds a locality");
assert.ok(s.services.includes("Drain cleaning"), "schema.org offers are services");
assert.ok(s.services.some((x) => /Water heater/i.test(x)), "services-page links are services");
assert.equal(s.pricing_mentioned, true, "a pricing page with $ amounts counts");
assert.deepEqual(s.booking_tools, ["Calendly"]);
assert.equal(s.forms_count, 1);
assert.deepEqual(s.analytics.sort(), ["Google Analytics", "Hotjar"]);
assert.deepEqual(Object.keys(s.socials).sort(), ["facebook", "instagram"]);
assert.ok(s.schema_types.includes("Plumber") && s.schema_types.includes("PostalAddress"));
assert.equal(s.copyright_year, 2024);
assert.equal(s.blog.found, true);
assert.equal(s.blog.latest_date, "2026-03-04");
assert.equal(s.images_total, 3);
assert.equal(s.images_missing_alt, 2);
assert.ok(s.internal_links >= 6, `internal ${s.internal_links}`);
assert.ok(s.external_links >= 3, `external ${s.external_links}`);
assert.ok(s.cta_phrases.includes("get a free quote") || s.cta_phrases.includes("free quote"), `ctas: ${s.cta_phrases.join("|")}`);
assert.ok(s.keywords.length > 0 && s.keywords.every((k) => k.term.length >= 4));
assert.ok(s.word_count > 30);
assert.ok(s.text_excerpt.includes("Licensed plumbers") && !s.text_excerpt.includes("<"));

// A site with no loaded pages yields the empty shape, never a throw.
const empty = extractSignals({ domain: "x.example", pages: [page("https://x.example/", "", 503)] });
assert.equal(empty.business_name, "x.example");
assert.deepEqual(empty.h1, []);
assert.equal(empty.forms_count, 0);

// A title without og:site_name: the brand after the separator when it reads as a name, else the first part.
const t = extractSignals({ domain: "y.example", pages: [page("https://y.example/", `<html><head><title>Emergency drains - Acme Plumbing Inc</title></head><body><h1>Hi</h1></body></html>`)] });
assert.equal(t.business_name, "Acme Plumbing Inc");
const t2 = extractSignals({ domain: "z.example", pages: [page("https://z.example/", `<html><head><title>Chez Lune | Brunch all day</title></head><body></body></html>`)] });
assert.equal(t2.business_name, "Chez Lune");

// Live scan 2026-11-12 (a Squarespace site): og:site_name was the whole title with a numeric
// entity, and a dropdown heading "Folder: Services" was listed as a service.
const sq = extractSignals({
  domain: "harpers.example",
  pages: [page("https://harpers.example/", `<html><head><title>Harper&#39;s Garden Centre | Hamilton, Ontario</title>
<meta property="og:site_name" content="Harper&#39;s Garden Centre &#124; Hamilton, Ontario"></head><body>
<nav><a href="/services">Folder: Services</a><a href="/services/design">Folder: Landscape design</a><a href="/products">Our products</a></nav>
<h1>Your local garden centre</h1></body></html>`)],
});
assert.equal(sq.og_site_name, "Harper's Garden Centre | Hamilton, Ontario", "numeric entities decode");
assert.equal(sq.business_name, "Harper's Garden Centre", "the name is what comes before the pipe");
assert.deepEqual(sq.services, ["Landscape design"], `a heading label is not a service: ${sq.services.join("|")}`);
// The site-health "Page title" row read the same title raw ("Harper&#39;s").
const sqTitle = runSiteChecks({ pages: [page("https://harpers.example/", `<html><head><title>Harper&#39;s Garden Centre &#124; Hamilton</title></head><body><h1>Hi</h1></body></html>`)], https: { served: true, httpRedirects: null }, sitemap: null }).find((ch) => ch.key === "title");
assert.equal(sqTitle?.detail, `The home page title is "Harper's Garden Centre | Hamilton".`);
const dash = extractSignals({ domain: "sj.example", pages: [page("https://sj.example/", `<html><head><meta property="og:site_name" content="Smith - Jones Law"></head><body></body></html>`)] });
assert.equal(dash.business_name, "Smith - Jones Law", "a hyphen is part of a name");
assert.ok(!s.services.includes("Services"), "the fixture's bare Services nav link is a heading");

// Live scan 2026-11-13 (cuisina.ca, Magento): the title "Home page | Cuisina" headed the report as
// "Home page". A page's own label is never the name, wherever it appears.
const home = extractSignals({ domain: "cuisina.example", pages: [page("https://cuisina.example/", `<html><head><title>Home page | Cuisina</title></head><body></body></html>`)] });
assert.equal(home.business_name, "Cuisina");
const accueil = extractSignals({ domain: "lune.example", pages: [page("https://lune.example/", `<html><head><title>Accueil - Fleuriste Lune</title></head><body></body></html>`)] });
assert.equal(accueil.business_name, "Fleuriste Lune");
const ogHome = extractSignals({ domain: "og.example", pages: [page("https://og.example/", `<html><head><title>Bakery Nord | Fresh bread</title><meta property="og:site_name" content="Home"></head><body></body></html>`)] });
assert.equal(ogHome.business_name, "Bakery Nord", "a generic og:site_name falls through to the title");
const onlyHome = extractSignals({ domain: "bare.example", pages: [page("https://bare.example/", `<html><head><title>Homepage</title></head><body></body></html>`)] });
assert.equal(onlyHome.business_name, "bare.example", "nothing but a page label: the domain");

// Live 2026-11-13: "Mandy Management Home" headed a report; a greeting is not part of a name either.
assert.equal(tidyName("Mandy Management Home"), "Mandy Management");
assert.equal(tidyName("Welcome to Joe's Pizza"), "Joe's Pizza");
assert.equal(tidyName("Bienvenue chez Fleuriste Lune"), "Fleuriste Lune");
assert.equal(tidyName("Sweet Home"), "Sweet Home", "a trailing label leaves at least two words, or stays");
assert.equal(tidyName("Home Depot"), "Home Depot", "only a trailing label goes");
const greeted = extractSignals({ domain: "mm.example", pages: [page("https://mm.example/", `<html><head><title>Mandy Management Home</title></head><body></body></html>`)] });
assert.equal(greeted.business_name, "Mandy Management");

console.log("site-scan-signals: ok");
