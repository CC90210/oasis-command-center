import assert from "node:assert/strict";
import {
  describeExtraction,
  extractUrls,
  ingestDedupeKey,
  ingestStateCopy,
  normalizeUrl,
  parseIngestUrl,
} from "../lib/founders/ingest-core";

/**
 * The front door of the training system. Adon pastes a link; this decides what
 * it is, what extractor runs, and what the dedupe identity is. Getting it wrong
 * means the wrong extractor fires or two ingests of the same video fight over
 * one corpus row.
 *
 * Run: npx tsx tests/founders-ingest-core.test.ts
 */

const ok = (raw: string) => {
  const r = parseIngestUrl(raw);
  assert.ok(r.ok, `expected ${raw} to parse, got: ${r.ok ? "" : r.reason}`);
  return r.ok ? r.target : (undefined as never);
};

// ── YouTube: every shape of link a human actually pastes ─────────────
for (const raw of [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "youtube.com/watch?v=dQw4w9WgXcQ", // no scheme, as pasted from a share sheet
]) {
  const t = ok(raw);
  assert.equal(t.kind, "youtube", raw);
  assert.equal(t.externalId, "dQw4w9WgXcQ", raw);
  assert.equal(t.extractor, "video");
  // All six canonicalise identically — that is what makes dedupe work.
  assert.equal(t.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", raw);
}

// Tracking params must not create a second corpus row for the same video.
assert.equal(
  ingestDedupeKey(ok("https://www.youtube.com/watch?v=abc12345678&utm_source=x&si=zzz&feature=share")),
  ingestDedupeKey(ok("https://youtu.be/abc12345678")),
  "the same video shared two ways dedupes to one key",
);

assert.equal(
  parseIngestUrl("https://www.youtube.com/").ok,
  false,
  "a bare YouTube homepage has no video to ingest",
);

// ── Instagram ────────────────────────────────────────────────────────
{
  const t = ok("https://www.instagram.com/reel/Cxyz123ABC/?igshid=abc");
  assert.equal(t.kind, "instagram");
  assert.equal(t.externalId, "Cxyz123ABC");
  assert.equal(t.canonicalUrl, "https://www.instagram.com/reel/Cxyz123ABC/");
  assert.ok(t.inspirable, "a reel is exactly what we want to take inspiration from");
}
{
  // /<user>/reel/<code> is the share-sheet shape
  const t = ok("https://instagram.com/oasisaisolutions/reel/Cxyz123ABC/");
  assert.equal(t.externalId, "Cxyz123ABC");
  assert.equal(t.canonicalUrl, "https://www.instagram.com/reel/Cxyz123ABC/");
}
{
  const t = ok("https://www.instagram.com/p/Cpost99/");
  assert.equal(t.canonicalUrl, "https://www.instagram.com/p/Cpost99/");
}
{
  // A bare profile is an account to learn from, not an error.
  const t = ok("https://www.instagram.com/oasisaisolutions");
  assert.equal(t.externalId, "oasisaisolutions");
  assert.equal(t.extractor, "article");
  assert.equal(t.inspirable, false, "a profile is not a single creative to replicate");
}

// ── TikTok ───────────────────────────────────────────────────────────
{
  const t = ok("https://www.tiktok.com/@someone/video/7300000000000000000");
  assert.equal(t.kind, "tiktok");
  assert.equal(t.externalId, "7300000000000000000");
  assert.equal(t.canonicalUrl, "https://www.tiktok.com/@someone/video/7300000000000000000");
}
{
  // Short links cannot be resolved without a network hop. Accept and let the
  // worker follow the redirect — rejecting the paste would be worse.
  const t = ok("https://vm.tiktok.com/ZMabc123/");
  assert.equal(t.kind, "tiktok");
  assert.equal(t.externalId, null);
  assert.match(t.label, /unresolved/i, "the UI must say the id is not known yet");
}

// ── GitHub ───────────────────────────────────────────────────────────
{
  const t = ok("https://github.com/CC90210/oasis-command-center");
  assert.equal(t.kind, "github");
  assert.equal(t.extractor, "repo");
  assert.equal(t.externalId, "CC90210/oasis-command-center");
  assert.equal(t.canonicalUrl, "https://github.com/CC90210/oasis-command-center");
}
{
  // Deep links collapse to the repo — one corpus row per repo, not per file.
  const t = ok("https://github.com/CC90210/oasis-command-center/blob/main/README.md");
  assert.equal(t.externalId, "CC90210/oasis-command-center");
  assert.equal(t.canonicalUrl, "https://github.com/CC90210/oasis-command-center");
}
{
  const t = ok("https://github.com/CC90210");
  assert.equal(t.externalId, "CC90210");
}

// ── generic web ──────────────────────────────────────────────────────
{
  const t = ok("https://example.com/blog/how-we-grew");
  assert.equal(t.kind, "web");
  assert.equal(t.extractor, "article");
}

// ── security: a fetcher must never be handed a non-http scheme ───────
for (const bad of [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "ftp://example.com/x",
  "",
  "   ",
  "not a url",
  "hello world",
]) {
  assert.equal(normalizeUrl(bad), null, `normalizeUrl must refuse ${JSON.stringify(bad)}`);
  assert.equal(parseIngestUrl(bad).ok, false, `parseIngestUrl must refuse ${JSON.stringify(bad)}`);
}
// A hostname with no dot is not a real host — refuses "localhost"-shaped input
// reaching a server-side fetcher (SSRF surface).
assert.equal(normalizeUrl("http://localhost:3000/admin"), null, "single-label hosts are refused");

// ── multi-paste: drop five links at once, get five items ─────────────
{
  const blob = `
    look at these
    https://www.youtube.com/watch?v=aaaaaaaaaaa
    https://www.instagram.com/reel/Bbbbbb/
    and this repo github.com/CC90210/oasis-command-center
    www.example.com/post,
  `;
  const urls = extractUrls(blob);
  assert.equal(urls.length, 4, `expected 4 links, got ${urls.length}: ${urls.join(" | ")}`);
  // trailing punctuation must not end up inside the URL
  assert.ok(!urls.some((u) => /[.,;:!?]$/.test(u)), "trailing punctuation stripped");
  for (const u of urls) assert.ok(parseIngestUrl(u).ok, `${u} parses`);
}
{
  // The same link twice in one paste is one item, not two.
  const urls = extractUrls("https://youtu.be/xyz1234567 and again https://youtu.be/xyz1234567");
  assert.equal(urls.length, 1, "duplicates within one paste collapse");
}
assert.deepEqual(extractUrls(""), []);
assert.deepEqual(extractUrls("no links here at all"), []);

// The bare-host pattern requires a path slash specifically so ordinary prose is
// not mistaken for a link. Without that, every "Node.js" or "e.g." in a pasted
// note would queue an ingest job.
for (const prose of [
  "We use Node.js and Next.js here.",
  "Ship it, e.g. tomorrow.",
  "Acme Inc. said no.",
  "version 4.2.1 shipped",
  "reach me at someone@example.com",
]) {
  assert.deepEqual(extractUrls(prose), [], `prose must not yield links: ${prose}`);
}
// ...but a real bare host WITH a path still counts.
assert.deepEqual(
  extractUrls("see github.com/CC90210/oasis-command-center for the code"),
  ["github.com/CC90210/oasis-command-center"],
  "a bare host with a path is a link",
);

// ── operator-facing copy exists for every state and extractor ────────
for (const s of ["queued", "extracting", "indexed", "failed", "skipped"] as const) {
  const c = ingestStateCopy(s);
  assert.ok(c.label.length > 0, `${s} has a label`);
  assert.ok(["pending", "active", "done", "bad"].includes(c.tone));
}
for (const raw of [
  "https://youtu.be/aaaaaaaaaaa",
  "https://github.com/a/b",
  "https://example.com/x",
  "https://www.instagram.com/reel/Cc/",
]) {
  const d = describeExtraction(ok(raw));
  assert.ok(d.length > 20, `${raw} has a real description of what will happen`);
}

// ── SSRF: an ingested link becomes a SERVER-side fetch ───────────────
// The extraction worker fetches whatever is in the corpus, so the parser is the
// place a hostile target has to die. Rejecting single-label hosts was the
// original control and it missed every IP literal, because an IP has dots in
// it. Found by CodeRabbit on PR #120.
for (const bad of [
  "http://127.0.0.1/x",
  "http://127.0.0.1./x", // trailing dot, still loopback
  "http://10.0.0.5/internal",
  "http://172.16.4.4/",
  "http://172.31.255.255/",
  "http://192.168.1.1/admin",
  "http://169.254.169.254/latest/meta-data/", // cloud instance metadata
  "http://0.0.0.0/",
  "http://100.64.0.1/", // CGNAT
  "http://[::1]/",
  "http://[fe80::1]/",
  "http://[fd00::1]/",
  "http://[::ffff:10.0.0.1]/",
  "http://[ff02::1]/", // multicast all-nodes
  "http://[ff05::2]/", // site-local multicast
  "http://[64:ff9b::a00:1]/", // NAT64-embedded 10.0.0.1
  "http://localhost:3000/",
  "http://printer.local/",
  "http://vault.internal/",
  "http://intranet/", // the original single-label case, still refused
]) {
  assert.equal(normalizeUrl(bad), null, `refuses an internal target: ${bad}`);
  assert.equal(parseIngestUrl(bad).ok, false, `refuses to classify an internal target: ${bad}`);
}

// ...and public addresses are untouched, including public IP literals.
for (const good of [
  "https://example.com/a",
  "https://8.8.8.8/a",
  "https://172.32.0.1/a",
  "https://192.169.0.1/a",
  "https://[2606:4700::1111]/a", // public IPv6
  "https://[64:ff9b::808:808]/a", // NAT64 translation of 8.8.8.8 — public
  "https://[::ffff:8.8.8.8]/a", // IPv4-mapped public address
]) {
  assert.ok(normalizeUrl(good), `still accepts a public target: ${good}`);
}

// ── a YouTube id reaches a fetched URL by interpolation ──────────────
// So it is charset-allowlisted, not merely encoded.
for (const bad of [
  "https://www.youtube.com/watch?v=abc%26list%3Devil",
  "https://www.youtube.com/watch?v=../../etc",
  "https://www.youtube.com/watch?v=",
]) {
  assert.equal(parseIngestUrl(bad).ok, false, `refuses a malformed video id: ${bad}`);
}
{
  const okVid = parseIngestUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.ok(okVid.ok && okVid.target.canonicalUrl === "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
}

// ── an unrecognised state must not take the Train page down ──────────
// `state` comes off a database row, not out of the type system: a later
// migration or the extraction worker can write one this build has never seen.
{
  const unknown = ingestStateCopy("something_new" as never);
  assert.ok(unknown && unknown.label.length > 0, "an unknown state still renders");
  assert.ok(["pending", "active", "done", "bad"].includes(unknown.tone));
}

console.log("founders-ingest-core: all assertions passed");
