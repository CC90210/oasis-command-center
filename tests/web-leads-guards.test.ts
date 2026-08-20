import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// Tenant scoping is the authorization boundary. libSQL has no row-level
// security, so if a route forgets to resolve the caller or pin the tenant,
// nothing else stops it serving another tenant's rows.
// ---------------------------------------------------------------------------
for (const route of [
  "app/api/web-leads/route.ts",
  "app/api/web-leads/facets/route.ts",
  "app/api/web-leads/[id]/route.ts",
]) {
  const src = read(route);
  assert.match(src, /resolveSessionContext/, `${route} must resolve the caller`);
  assert.match(src, /status:\s*401/, `${route} must fail closed on an unresolved caller`);
  // A bare `status: 401` grep is not enough: these routes were ACTUALLY BROKEN
  // in exactly the way that check would miss. The original code read
  // `if (!session)`, but resolveSessionContext() returns a discriminated
  // union (`{ ok: false, reason }`) which is always truthy -- so the guard
  // could never fire, every route was effectively public, and the literal
  // `status: 401` sat right there in the file passing the grep the whole
  // time. This asserts the CONDITION that actually fires, not the constant
  // sitting downstream of a check that never runs.
  assert.match(
    src,
    /if\s*\(\s*!\s*session\.ok\s*\)/,
    `${route} must branch on session.ok, not on session's truthiness`,
  );
}

const data = read("lib/web-leads/data.ts");
assert.match(data, /WEBDEV_TENANT_ID/, "reads must pin the tenant");
// Every table read pins the tenant. Count the reads and the pins together so a
// new unpinned query cannot slip in beside the pinned ones.
//
// The file's header doc-comment itself mentions `.from()` twice while
// explaining the shared query-builder dialect, and its WEBDEV_TENANT_ID doc
// comment deliberately spells out "NOT SunBiz (aa04fa1f...)" so a future
// editor doesn't paste the wrong tenant in by hand. A naive count/match over
// the raw source (including comments) trips on both: it counts 5 "reads"
// against 3 real calls, and it flags the SunBiz id inside the very comment
// that exists to keep it OUT of real code. Strip block comments first so
// these checks look at code, not the prose explaining the code.
const code = data.replace(/\/\*[\s\S]*?\*\//g, "");
const froms = (code.match(/\.from\(/g) || []).length;
const pins = (code.match(/\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/g) || []).length;
assert.equal(pins, froms, `every read must pin the tenant (${froms} reads, ${pins} pinned)`);
// The SunBiz tenant must never appear as a real value (a string literal, an
// assignment, a query filter) anywhere in this feature -- only inside the
// explanatory comment above, which the block-comment strip already removed.
assert.doesNotMatch(code, /aa04fa1f/, "this feature must never reference the SunBiz tenant in real code");

// ---------------------------------------------------------------------------
// The un-audited wording reaches the screen VERBATIM. Nothing has fetched these
// sites; OSM lacking a website tag means nobody mapped one. A rep reading a
// fabricated finding on a live call is the worst outcome this system can
// produce, and a badge is exactly how that nuance gets flattened.
// ---------------------------------------------------------------------------
for (const view of [
  "components/web-leads/LeadsTable.tsx",
  "components/web-leads/WebLeadDetail.tsx",
]) {
  const src = read(view);
  assert.match(src, /websiteCondition/, `${view} should show the website status`);
  // No view may hardcode a shorter, more confident verdict.
  assert.doesNotMatch(src, /"No website"/, `${view} must not render a bare "No website" verdict`);
  assert.doesNotMatch(src, /No significant issues/, `${view} must not claim a clean audit`);
}

console.log("web-leads-guards ok");
