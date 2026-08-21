import assert from "node:assert";
import { safeExternalUrl } from "../lib/web-leads/url-safety";

// P2 fix (2026-08-21, independent review of the Task 4 panel): 217 of the
// 27,497 stored websites are bare domains with no scheme (e.g.
// "whitfield.co"). A bare string in an <a href> is app-RELATIVE, so a rep
// clicking "View website" lands inside our own dashboard, not the prospect's
// site -- mid-call, exactly when the click was meant to matter.
assert.equal(safeExternalUrl("whitfield.co"), "https://whitfield.co/", "bare domain must get https://");
assert.equal(safeExternalUrl("sub.example.com/path"), "https://sub.example.com/path", "bare domain with path must get https://");

// Already-scheme'd URLs pass through untouched (aside from URL's own
// normalization, e.g. a trailing slash on a bare origin).
assert.equal(safeExternalUrl("http://example.com"), "http://example.com/", "http:// must pass through");
assert.equal(safeExternalUrl("https://example.com/about"), "https://example.com/about", "https:// must pass through");

// These OSM-sourced values come from a public map anyone can edit and are
// ingested automatically (~27,000 rows, no human review). Zero dangerous
// values exist in the data today -- that is a fact about today's snapshot,
// not a control. A javascript: value reaching an <a href> would execute in
// our app's own origin the instant a rep clicked it: untrusted third-party
// data reaching an href is exactly the shape of stored XSS delivered
// through a link, so the scheme must be ALLOWLISTED (http/https only), not
// merely denylisted against the schemes we happened to think of.
assert.equal(safeExternalUrl("javascript:alert(1)"), null, "javascript: must be rejected");
assert.equal(safeExternalUrl("JavaScript:alert(1)"), null, "javascript: must be rejected case-insensitively");
assert.equal(safeExternalUrl("data:text/html,<script>alert(1)</script>"), null, "data: must be rejected");

// Empty / whitespace-only / unparseable input must render nothing, never a
// dead or dangerous link.
assert.equal(safeExternalUrl(""), null, "empty string must return null");
assert.equal(safeExternalUrl("   "), null, "whitespace-only must return null");
assert.equal(safeExternalUrl(null), null, "null must return null");
assert.equal(safeExternalUrl("://not a url"), null, "unparseable input must return null");

console.log("web-leads-url-safety ok");
