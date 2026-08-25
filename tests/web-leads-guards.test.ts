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
  // Branching on session.ok is not enough on its own: these three routes
  // ACTUALLY LEAKED every one of ~31,000 Web Studio leads to any
  // authenticated user of ANY tenant, because they resolved session.tenantId
  // and never read it -- reads were pinned to a hardcoded WEBDEV_TENANT_ID
  // regardless of who was asking. A guard that only checks "is there a
  // session.ok branch" passed the whole time this was broken. This asserts
  // the caller is actually CONSTRAINED to the tenant, not merely resolved:
  // the route must compare session.tenantId against the pinned tenant and
  // fail closed with a 403 when it doesn't match.
  assert.match(
    src,
    /session\.tenantId/,
    `${route} must reference session.tenantId -- resolving it and never checking it is how this leaked`,
  );
  assert.match(
    src,
    /status:\s*403/,
    `${route} must refuse a caller from another tenant with a 403`,
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
// The shared block is asserted FIRST and by name, because the two host views
// below are allowed to satisfy the requirement by importing it. If that
// indirection were permitted without pinning the component it points at, an
// empty <BusinessFacts /> would pass every assertion in this section.
{
  const facts = "components/web-leads/BusinessFacts.tsx";
  const src = read(facts);
  assert.match(src, /lead\.websiteCondition/, `${facts} must render the website status`);
  assert.match(src, /lead\.auditFindings/, `${facts} must render the research notes`);
  // Verbatim means the field reaches the screen as-is. A slice, a split, a
  // replace or a truncate class on the way there is the shortening this rule
  // exists to forbid.
  assert.doesNotMatch(
    src,
    /(websiteCondition|auditFindings)\s*[.?]?\.?(slice|substring|split|replace|toUpperCase|toLowerCase)/,
    `${facts} must not transform the verbatim directory strings`,
  );
  assert.doesNotMatch(src, /truncate/, `${facts} must not truncate a verbatim directory string`);
}

for (const view of [
  "components/web-leads/LeadsTable.tsx",
  "components/web-leads/WebLeadDetail.tsx",
  // Added 2026-08-24. The battle card shipped WITHOUT the identity block --
  // zero references to address, postal, osmCategory or territoryName -- so a
  // rep working a lead in their own book could not see where the business was.
  // It is now held to the same rule as the drawer rather than trusted to keep
  // carrying the block it was missing on day one.
  "components/web-leads/BattleCard.tsx",
]) {
  const src = read(view);
  // Either the view renders the field itself (LeadsTable does, for the
  // no-website cell) or it delegates to the ONE shared block, which is
  // separately pinned above. Delegation is the outcome this codebase wants:
  // two hand-maintained copies of a lead's address on two screens are two
  // things that can disagree about the same business mid-call.
  assert.match(
    src,
    /websiteCondition|<BusinessFacts/,
    `${view} should show the website status, itself or through the shared BusinessFacts block`,
  );
  // No view may hardcode a shorter, more confident verdict.
  assert.doesNotMatch(src, /"No website"/, `${view} must not render a bare "No website" verdict`);
  assert.doesNotMatch(src, /No significant issues/, `${view} must not claim a clean audit`);
}

// ---------------------------------------------------------------------------
// fetchLeads reads tenant_records with no server-side predicate on most
// filters (territory lives inside a JSON blob) and previously had no
// `.limit()` at all. getServiceSupabase() falls back to a real supabase-js
// client whenever EMPIRE_DATA_BACKEND isn't "turso_cloud", and PostgREST
// enforces its own server-side max-rows cap -- so an unbounded read on that
// path comes back SILENTLY TRUNCATED, no error, just fewer rows. The filter
// rail would confidently show a count the table couldn't back up, and
// nothing would say the number was wrong. A read that can come back short
// must fail loudly instead of returning a partial list that looks complete,
// so this asserts both the cap and the throw exist, not just that a
// `.limit(` call is present somewhere.
// ---------------------------------------------------------------------------
assert.match(data, /LEAD_READ_CAP/, "fetchLeads must reference LEAD_READ_CAP");

// STRENGTHENED 2026-08-23 (Codex review). The old assertion here required
// `if (rows.length >= LEAD_READ_CAP) throw`, which only catches truncation by
// OUR cap. PostgREST enforces its own server-side max-rows (commonly 1,000)
// regardless of what `.limit(50000)` asks for; on that path the response comes
// back under our cap, the check passes, and most of the tenant's leads go
// missing with nothing on screen to say so. Completeness is now PROVED against
// each read's own match count instead.
//
// Every full scan in this file must do it, not just the one a reviewer happened
// to read: the weaker check survived in this file precisely because two other
// scans still carried it and kept the old regex matching.
{
  const scans = code.match(/\.from\("tenant_records"\)[\s\S]*?\.limit\(LEAD_READ_CAP\)/g) || [];
  assert.ok(scans.length >= 3, `expected every tenant_records full scan to be found, saw ${scans.length}`);
  for (const scan of scans) {
    assert.match(
      scan,
      /\{ count: "exact" \}/,
      "every full scan must request an exact count -- it is the only way to prove the read was not truncated by a server-side cap",
    );
  }
  // `assertCompleteRead("` — the open quote is what distinguishes a real call
  // (which passes a string label) from the several line comments that name the
  // function. Block comments are already stripped from `code`; line comments
  // are not, and matching them inflated this count to 6.
  const completeness = code.match(/assertCompleteRead\("/g) || [];
  assert.equal(
    completeness.length,
    scans.length,
    "every full scan must pass through assertCompleteRead, one call per scan",
  );
  // The weaker form must not creep back in beside the stronger one.
  assert.doesNotMatch(
    code,
    /if\s*\([^)]*>=\s*LEAD_READ_CAP[^)]*\)\s*{\s*throw/,
    "a row-count-versus-cap check is not a completeness check -- it passes silently when a server cap truncates below it",
  );
}

// ---------------------------------------------------------------------------
// A TENANT CHECK ALONE IS NOT SUFFICIENT. #237 (26ecc31a) hardened the
// manifest records route because `agent` is the commission-only OUTSIDE
// CONTRACTOR role added for website sales -- it lives INSIDE the tenant, so
// passing session.tenantId === WEBDEV_TENANT_ID is not proof a caller may
// see every lead in it. This branch reads the same tenant_records table
// through a different door (the Web Leads browser) and would reopen the
// exact leak #237 closed if it didn't apply the identical role scoping.
// These assertions require each route to actually WIRE the scoping through
// (reference the role/viewer), and require the data layer to key off
// assigned_to -- not just assert that a scoping FUNCTION exists somewhere
// unused, which would pass even if no route called it.
// ---------------------------------------------------------------------------
for (const route of [
  "app/api/web-leads/route.ts",
  "app/api/web-leads/facets/route.ts",
  "app/api/web-leads/[id]/route.ts",
]) {
  const src = read(route);
  assert.match(
    src,
    /session\.teamRole/,
    `${route} must reference session.teamRole -- tenant match alone does not exclude the outside-contractor role`,
  );
  assert.match(
    src,
    /session\.isAdmin/,
    `${route} must reference session.isAdmin when building the viewer passed to the scoped data layer`,
  );
}
assert.match(
  data,
  /assigned_to/,
  "lib/web-leads/data.ts must reference assigned_to -- that is what an agent's lead scope is keyed on",
);
assert.match(
  data,
  /isScopedContractor|visibleToViewer/,
  "lib/web-leads/data.ts must implement the agent-role scoping predicate, not just pin the tenant",
);
// Presence of visibleToViewer SOMEWHERE in the file is not enough -- it could
// exist only in fetchLead or fetchSheetsScopedToViewer while fetchLeads (the
// main list read, ~31K rows) stays unscoped. Isolate fetchLeads' own body
// (top-level closing brace is unindented; every nested brace inside it is
// not) and require the scoping call INSIDE it specifically.
// \r?\n rather than \n: lib/web-leads/data.ts is stored in git WITH CRLF, so a
// bare \n\}\n never matched and this guard failed on every checkout — taking the
// rest of the suite with it, since the runner stops at the first failure. The
// assertion below is unchanged; only its line-ending assumption is.
const fetchLeadsBody = code.match(/export async function fetchLeads\([\s\S]*?\r?\n\}\r?\n/);
assert.ok(fetchLeadsBody, "must find fetchLeads() in lib/web-leads/data.ts");
// RESTATED 2026-08-23, NOT RELAXED. This asserted `visibleToViewer` by name.
// Ownership replaced that mechanism: a contractor must now be able to SEE the
// claimable pool (unassigned leads are the inventory they are meant to claim --
// Adon: "all the accounts can assign themselves the lead"), while still never
// reading another rep's book. visibleToViewer, which hides every unassigned
// lead from an agent, would have handed those reps an empty pool and a Claim
// button that could not work.
//
// The property PR #237 actually protects is unchanged and is asserted directly
// below: no caller ever receives a lead that belongs to someone else. It now
// holds by construction rather than by a filter --
//
//   scope "mine" -> isInBookOf(.., viewer.userId), self-scoping by definition;
//   scope "pool" -> isClaimable(..), which excludes every currently-held lead.
//
// Plus: a pool lead can still carry a PREVIOUS owner (an expired claim, a
// recycled loss), so the owner id is nulled for anyone but that lead's own
// holder or an admin -- otherwise the pool would quietly tell a contractor
// which rep had which business.
assert.match(
  fetchLeadsBody[0],
  /scope === "mine"\s*\?\s*isInBookOf\(factsFrom\(r\.data \|\| \{\}\), viewer\.userId\)\s*:\s*isClaimable\(/,
  "fetchLeads must scope 'mine' to the caller's own book and 'pool' to unheld leads -- tenant-pinning the read alone is not enough, an agent-role contractor sits INSIDE the tenant",
);
assert.match(
  fetchLeadsBody[0],
  /assignedTo: ownedByViewer \|\| viewer\.isAdmin \? facts\.assignedTo : null/,
  "fetchLeads must not surface another rep's user id on a pool lead -- an expired claim still names its previous owner",
);

// ---------------------------------------------------------------------------
// Task 3 (2026-08-21 build-a-lead-detail plan): the audit endpoint is a NEW
// door onto the same tenant_records table, so it must pass the identical
// auth gate the loop above already proves for the sibling routes -- resolve
// the caller, branch on session.ok (not session's truthiness, the same bug
// class documented above), fail closed on an unresolved caller, and refuse a
// caller from another tenant before any read.
// ---------------------------------------------------------------------------
{
  const route = "app/api/web-leads/[id]/audit/route.ts";
  const src = read(route);
  assert.match(src, /resolveSessionContext/, `${route} must resolve the caller`);
  assert.match(
    src,
    /if\s*\(\s*!\s*session\.ok\s*\)/,
    `${route} must branch on session.ok, not on session's truthiness`,
  );
  assert.match(src, /status:\s*401/, `${route} must fail closed on an unresolved caller`);
  assert.match(
    src,
    /session\.tenantId/,
    `${route} must reference session.tenantId -- resolving it and never checking it is how the sibling routes leaked`,
  );
  assert.match(src, /status:\s*403/, `${route} must refuse a caller from another tenant with a 403`);
}

// ---------------------------------------------------------------------------
// THE RULE THAT OUTRANKS THE FEATURE: a site we could not reach is NEVER
// given a score, and the head-to-head "ours vs theirs" benchmark ships
// default OFF because our own sites do not yet win it -- shipping it live
// would put a rep in front of a prospect whose site beats ours. This asserts
// both that the flag gate exists in the data layer (not just described in a
// doc) and that a comment explains WHY it defaults off, so a future editor
// cannot flip it to always-on without also deleting the reasoning that
// argues against that.
// ---------------------------------------------------------------------------
const auditLib = read("lib/web-leads/audit.ts");
assert.match(auditLib, /WEBDEV_SHOW_BENCHMARK/, "lib/web-leads/audit.ts must reference WEBDEV_SHOW_BENCHMARK");
assert.match(
  auditLib,
  /own sites do not yet win|do not yet win this comparison|our own sites/i,
  "lib/web-leads/audit.ts must comment that the benchmark comparison is default-off because our own sites do not yet win it",
);
// A comment explaining WHY the flag defaults off is not itself a guard: the
// actual condition could still be written `!== "false"` (which also
// "references WEBDEV_SHOW_BENCHMARK" and would pass a presence-only check)
// and default the benchmark ON. This pins the fail-closed direction of the
// check itself, not just its presence.
assert.match(
  auditLib,
  /WEBDEV_SHOW_BENCHMARK\s*===\s*"true"/,
  'lib/web-leads/audit.ts must gate the benchmark on WEBDEV_SHOW_BENCHMARK === "true" (fail closed) -- any other comparison could default it on',
);

// ---------------------------------------------------------------------------
// Task 5 (2026-08-21 build-a-lead-detail plan): pin the honesty rules Task 4
// shipped as tests, so a future edit can't quietly reintroduce a fabricated
// finding. Nothing has verified these prospects' websites except our own
// crawler -- a site we could not reach may be perfectly good -- and if a rep
// reads a fabricated finding aloud to a stranger on a live call, that is the
// worst outcome this whole system can produce. A polished UI is exactly
// where that nuance gets flattened: a badge, a colour, or a shortened
// verdict string all read as more confident than the underlying data is.
// ---------------------------------------------------------------------------
for (const view of [
  "components/web-leads/WebsiteComparison.tsx",
  "components/web-leads/WebLeadDetail.tsx",
  // Added 2026-08-23 with Call Mode. This is the surface a rep reads WHILE the
  // prospect is on the line -- the one place where a colour that says "bad
  // site" turns straight into a spoken claim -- so it earns the same ban as
  // the panel rather than being trusted to stay clean on its own.
  "components/web-leads/CallMode.tsx",
  // Added 2026-08-24 with the battle card. It is the densest surface in the
  // feature -- a radar, a distribution strip, seven recoverable-points bars, a
  // head-to-head track per dimension, and a percentile marker -- which makes it
  // the file where a colour keyed to a score is both most tempting and most
  // damaging. A red arc beside a named local competitor is a rep telling a
  // stranger their site is bad on the authority of a gradient. Proved to fire
  // against this file by planting `text-red-400` on the composite score once
  // (2026-08-24): the assertion failed as intended, and the class was reverted.
  "components/web-leads/BattleCard.tsx",
  // Added 2026-08-24 with the objection panel. It renders no audit data at all,
  // which is exactly why it earns the ban rather than an exemption: a surface
  // that is "obviously safe" today is the one a future editor tints to make a
  // brush-off card look like a warning, and a rep reading a red card about
  // "no budget" hears a verdict about the prospect that nothing measured.
  "components/web-leads/ObjectionPanel.tsx",
  // Added 2026-08-24 with the shared identity block. It is the file that now
  // renders BOTH verbatim directory sentences on BOTH surfaces, which makes it
  // the single most tempting place to "helpfully" tint a bad website status
  // red -- one edit here would colour a judgement onto every screen in the
  // feature at once.
  "components/web-leads/BusinessFacts.tsx",
  // Added 2026-08-24 with opening hours. The open/closed indicator is the single
  // most tempting place in this feature to reach for green and red, and because
  // open/closed is factual state rather than a judgement, the temptation feels
  // harmless. It is not: a green dot two columns from a website score teaches
  // the eye that colour means quality on this screen, and the next person tints
  // the score. So the state is carried by WORDS and by SHAPE -- filled dot,
  // ring, dash -- which also survives greyscale and colour blindness, and the
  // only colour in the file is the neutral accent. Proved to fire against this
  // file by planting `bg-green-500 text-red-400` on the open-state dot once
  // (2026-08-24): the assertion failed as intended, and the classes were
  // reverted.
  "components/web-leads/OpeningHours.tsx",
  // Added 2026-08-25 with the per-industry automations panel. It renders a
  // "they do not have this" marker off the audit, which is the single most
  // tempting thing on this feature to tint: the marker is derived from a
  // measurement, so colouring it feels like reporting rather than judging.
  // It is not. The marker is carried by a word and a hollow ring instead.
  // Proved to fire against this file by planting `text-red-400 bg-green-500`
  // on the marker once (2026-08-25): the assertion failed as intended, and
  // the classes were reverted.
  "components/web-leads/AutomationPanel.tsx",
]) {
  const src = read(view);

  // No standalone "No website" verdict. The quote-scoped regex matches only
  // the bare four-word JS string literal (e.g. a future `websiteCondition ||
  // "No website"` fallback) -- it will NOT false-positive on the hedged
  // sentence below, which is plain JSX text that never closes its quotes
  // right after the word "website".
  assert.doesNotMatch(src, /"No website"/, `${view} must not render a bare "No website" verdict`);

  // No colour class keyed to a score. Red says "bad", green says "good" --
  // neither is something the number backs up when nothing but our own
  // crawler has ever looked at the site. One exception: the generic "could
  // not load" network-error banner, which is a pre-existing, repo-wide
  // convention (28+ other components render a fetch failure with the exact
  // same `border-amber-200 bg-amber-50 ... text-amber-900` triple) and fires
  // before any audit data even exists -- it is not a judgement about a
  // score. That one paragraph is identified by rendering the literal
  // `{error}` fetch-failure state, not any audit/score field, so stripping
  // it before checking targets colour attached to actual audit content
  // without flagging an unrelated, already-shipped app convention.
  const withoutLoadErrorBanner = src.replace(/<p className="[^"]*amber[^"]*">\{error\}<\/p>;?/g, "");
  for (const cls of ["text-red-", "bg-red-", "text-green-", "bg-green-", "bg-amber-"]) {
    assert.doesNotMatch(
      withoutLoadErrorBanner,
      new RegExp(cls.replace(/-/g, "\\-")),
      `${view} must not attach ${cls} to audit/score content -- a colour keyed to a score renders a judgement the number does not support`,
    );
  }
}

// The hedged phrasing is what must actually appear where a bare "No website"
// verdict was tempting to write -- absence of the bad string is not proof the
// honest one replaced it.
assert.match(
  read("components/web-leads/WebsiteComparison.tsx"),
  /No website found yet, needs checking/,
  "WebsiteComparison must render the hedged no-website message, not merely avoid the bare verdict",
);

// WebsiteComparison must actually HANDLE the unreachable state, not just
// avoid contradicting it: reference `unreachable` and render sentence text
// for it. A site we could not reach may be perfectly fine -- silently
// falling through to "no website" (which reads as neutral/available) or to
// a score of zero (which reads as a verdict) would both be dishonest in a
// different way than naming the failure plainly.
{
  const src = read("components/web-leads/WebsiteComparison.tsx");
  assert.match(src, /unreachable/, "WebsiteComparison must reference the unreachable audit state");
  assert.match(
    src,
    /audit\.state === "unreachable"[\s\S]{0,400}?<p[^>]*>[^<]*could not check[^<]*<\/p>/i,
    "WebsiteComparison must render sentence text for the unreachable state, not merely mention the word",
  );
}

// The external "View website" link opens one of 27,000 sites we do not
// control and have not vetted. Without rel="noopener noreferrer", the
// opened tab can reach back through window.opener (e.g. redirect the
// original tab to a fake "session expired" page) -- a real security
// requirement, not a style nit, and easy to lose in a refactor of this link.
for (const view of [
  "components/web-leads/WebLeadDetail.tsx",
  // The shared identity block carries its own "View website" link, on both
  // surfaces at once, so it needs the same requirement rather than inheriting
  // trust from the button beside it.
  "components/web-leads/BusinessFacts.tsx",
]) {
  const src = read(view);
  // Counted rather than merely found: a second link added later without the
  // rel is exactly what a presence check misses.
  const blanks = (src.match(/target="_blank"/g) || []).length;
  const safe = (src.match(/target="_blank"[\s\S]{0,160}?rel="noopener noreferrer"/g) || []).length;
  assert.ok(blanks >= 1, `${view} must open the prospect's site in a new tab`);
  assert.equal(
    safe,
    blanks,
    `every target="_blank" in ${view} must carry rel="noopener noreferrer" -- without it the opened tab reaches back through window.opener`,
  );
  // And the href must come from the allowlisting helper, never the raw stored
  // value: 217 of these are bare domains (which navigate inside our own
  // dashboard) and they come from a public map anyone can edit.
  assert.match(src, /preferredSiteUrl\(/, `${view} must resolve the website URL through preferredSiteUrl`);
  assert.doesNotMatch(
    src,
    /href=\{lead\.websiteUrl\}/,
    `${view} must never put the raw stored websiteUrl in an href`,
  );
}

console.log("web-leads-guards ok");
