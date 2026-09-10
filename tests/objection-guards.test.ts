import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * One exported function's source, from its declaration to the start of the
 * next top-level `export` (or end of file).
 *
 * NOT a `[\s\S]*?\n\}` match, which is what the sibling
 * tests/web-leads-outcome-guards.test.ts uses and which silently returns the
 * SIGNATURE ONLY for any function taking a multi-line object parameter -- the
 * `}` closing that parameter's inline type sits at column 0 and ends the
 * non-greedy match before the body is reached. Every assertion made against
 * such a fragment then passes or fails on the argument list rather than on the
 * code, which is a test that looks strict and checks nothing.
 */
function exportedFn(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

// ---------------------------------------------------------------------------
// The objection engine's equivalent of tests/web-leads-outcome-guards.test.ts,
// written to the same convention and for the same reason. Spec section 10 asked
// for tenant-pinning coverage and it was absent: before this file, NOTHING in
// the branch would have noticed a tenant pin being dropped from catalog.ts,
// events.ts, or either route, and nothing pinned the auth gate on either route
// at all. libSQL has no row-level security, so these routes and these two
// modules ARE the boundary -- there is no second line behind them.
//
// LIMITATION, STATED UP FRONT, same as the sibling: these are source-text
// tripwires. They catch a deletion or a loosening that changes the vocabulary
// of the file. They cannot prove the matched text is on the live path, and
// they are not a substitute for the runtime coverage in
// tests/objection-catalog.test.ts and tests/objection-events.test.ts. They
// exist because Step 5 of this build already proved that changing
// `if (session.tenantId !== WEBDEV_TENANT_ID)` to `if (false)` compiles clean:
// nothing in the type system catches a loosened tenant check.
// ---------------------------------------------------------------------------

const COLLECTION_ROUTE = "app/api/web-leads/[id]/objections/route.ts";
const EVENT_ROUTE = "app/api/web-leads/[id]/objections/[eventId]/route.ts";
const CATALOG = "lib/web-leads/objections/catalog.ts";
const EVENTS = "lib/web-leads/objections/events.ts";
const CARD = "components/web-leads/ObjectionCard.tsx";
const CONSOLE_VIEW = "components/web-leads/ObjectionConsole.tsx";
const MIGRATION = "database/turso/171_objection_engine.turso.sql";
const PREMISE_MIGRATION = "database/turso/172_objection_website_premise.turso.sql";

// EVERY structural assertion below runs against COMMENT-STRIPPED source, and
// that is load-bearing rather than tidiness. app/api/.../[eventId]/route.ts's
// own docblock quotes the string `if (session.tenantId !== WEBDEV_TENANT_ID)`
// while explaining why the check is duplicated per route, so a check written
// against the raw file matches the COMMENT: changing the real line to
// `if (false)` left this file green. That is the same dead-comment decoy hole
// commit 93ef9734 closed in the no-truncation guard, found again here by
// proving each assertion fires.
const collection = stripComments(read(COLLECTION_ROUTE));
const eventRoute = stripComments(read(EVENT_ROUTE));
const catalog = read(CATALOG);
const events = read(EVENTS);

// ---------------------------------------------------------------------------
// 1. THE AUTH GATE, on BOTH routes. Each is a new door onto tenant_records and
// onto three new tables, so each must resolve the caller, branch on
// session.ok (not on session's truthiness), fail closed on an unresolved
// caller, refuse another tenant, and answer 404 rather than 403 for a lead
// outside the viewer's scope so an id is not probeable -- all BEFORE any read
// or write.
// ---------------------------------------------------------------------------
for (const [label, src] of [[COLLECTION_ROUTE, collection], [EVENT_ROUTE, eventRoute]] as const) {
  assert.match(src, /resolveSessionContext/, `${label} must resolve the caller`);
  assert.match(
    src,
    /if\s*\(\s*!\s*session\.ok\s*\)/,
    `${label} must branch on session.ok, not on session's truthiness`,
  );
  assert.match(src, /status:\s*401/, `${label} must fail closed on an unresolved caller`);
  assert.match(
    src,
    /session\.tenantId !== WEBDEV_TENANT_ID/,
    `${label} must actually compare session.tenantId against WEBDEV_TENANT_ID -- resolving it and never checking it is how the sibling routes leaked`,
  );
  assert.match(src, /status:\s*403/, `${label} must refuse a caller from another tenant with a 403`);

  // A tenant check alone is not sufficient: `agent` is the commission-only
  // outside-contractor role that lives INSIDE the tenant (isScopedContractor
  // in lib/web-leads/data.ts), so the viewer's role and admin bits must reach
  // fetchLead, not just the tenant pin.
  assert.match(src, /fetchLead\(/, `${label} must call fetchLead so agent-role scoping applies, not just the tenant pin`);
  assert.match(src, /status:\s*404/, `${label} must answer 404, not 403, for a lead outside the viewer's scope`);
  assert.match(src, /session\.teamRole/, `${label} must reference session.teamRole when building the viewer`);
  assert.match(src, /session\.isAdmin/, `${label} must reference session.isAdmin when building the viewer`);

  // Ownership, not merely a sales role. `owned_oasis_sales` is the centralized
  // per-lead policy; naming it here means a change to that policy reaches this
  // feature instead of this feature carrying its own copy of the rule.
  assert.match(src, /accessMode:\s*"owned_oasis_sales"/, `${label} must use the centralized OASIS ownership policy`);
}

// The mutation gate lives in the MUTATING handler, never in the shared
// authorize() helper, or the GET stops being visible to a manager.
{
  const post = collection.match(/export\s+async\s+function\s+POST[\s\S]*$/)?.[0] || "";
  assert.match(post, /mayWorkWebsiteSalesLifecycle\(/, `${COLLECTION_ROUTE} POST must use the centralized sales-role gate`);
  assert.match(post, /leadMutationAccess\(auth\.session, id\)/, `${COLLECTION_ROUTE} POST must prove ownership after proving the sales role`);
  assert.match(eventRoute, /mayWorkWebsiteSalesLifecycle\(/, `${EVENT_ROUTE} PATCH must use the centralized sales-role gate`);
  assert.match(eventRoute, /leadMutationAccess\(auth\.session, id\)/, `${EVENT_ROUTE} PATCH must prove ownership after proving the sales role`);

  for (const [label, src] of [[COLLECTION_ROUTE, collection], [EVENT_ROUTE, eventRoute]] as const) {
    const authorizeFn = src.match(/async function authorize\([\s\S]*?\n\}/)?.[0] || "";
    assert.ok(authorizeFn.length > 0, `${label} must have an authorize() helper this can inspect`);
    assert.doesNotMatch(
      authorizeFn,
      /mayWorkWebsiteSalesLifecycle\(/,
      `${label} must preserve read visibility instead of applying the mutation gate in shared authorization`,
    );
  }
  assert.match(
    collection,
    /canMutate:\s*mutationAccess\.ok/,
    `${COLLECTION_ROUTE} GET must return the per-lead mutation decision without hiding history`,
  );
  assert.match(read(CONSOLE_VIEW), /canMutate:\s*responseBody\.canMutate === true/, `${CONSOLE_VIEW} must hide the tap until the GET proves per-lead ownership`);
}

// ---------------------------------------------------------------------------
// 2. TENANT PINNING ON EVERY QUERY. The rule spec section 3 states: libSQL has
// no row-level security, so every read and every write pins WEBDEV_TENANT_ID
// explicitly. Asserted structurally rather than by counting a string, so a new
// `.from(` added later without a pin fails HERE and names itself.
// ---------------------------------------------------------------------------
for (const [label, src] of [[CATALOG, catalog], [EVENTS, events]] as const) {
  const code = stripComments(src);
  const froms = [...code.matchAll(/\.from\("([a-z_]+)"\)/g)];
  assert.ok(froms.length >= 2, `${label}: expected several table accesses to check, found ${froms.length}`);
  for (const [i, match] of froms.entries()) {
    const table = match[1];
    // The window runs to the NEXT `.from(`, never a fixed character count: a
    // fixed window overlaps the following query, so deleting one pin is
    // covered by its neighbour's and the check silently passes. (Proved: with
    // a 600-character window, removing the pin from the objection_catalog read
    // in catalog.ts still passed this file.)
    const start = match.index ?? 0;
    const end = i + 1 < froms.length ? (froms[i + 1].index ?? code.length) : code.length;
    const window = code.slice(start, end);
    assert.ok(
      /\.eq\("tenant_id", WEBDEV_TENANT_ID\)/.test(window) || /tenant_id:\s*WEBDEV_TENANT_ID/.test(window),
      `${label}: the query on "${table}" must pin WEBDEV_TENANT_ID -- libSQL has no row-level security, this pin IS the boundary`,
    );
  }
}

// The insert specifically, named rather than left to the window check above:
// an objection_event row written without a tenant is a row every tenant's
// scoreboard can read.
assert.match(
  stripComments(events),
  /\.insert\(\{[\s\S]{0,200}?tenant_id:\s*WEBDEV_TENANT_ID/,
  `${EVENTS} must stamp tenant_id on the objection_event insert`,
);

// ---------------------------------------------------------------------------
// 3. THE PATCH IS SCOPED TO ITS OWN LEAD, not just to the tenant. Final review,
// BLOCKING 5: `accessMode: "owned_oasis_sales"` is a PER-LEAD ownership
// boundary, so proving the caller may work lead A and then updating an event
// pinned only by tenant_id + id let lead A's owner attach a resolution to lead
// B's event by naming lead A in the path.
// ---------------------------------------------------------------------------
{
  const patchFn = exportedFn(events, "patchObjectionEvent");
  assert.ok(patchFn.length > 0, `${EVENTS} must export patchObjectionEvent`);
  const patchCode = stripComments(patchFn);
  assert.match(patchCode, /\.eq\("tenant_id", WEBDEV_TENANT_ID\)/, `${EVENTS} patch must pin the tenant`);
  assert.match(
    patchCode,
    /\.eq\("lead_record_id", leadRecordId\)/,
    `${EVENTS} patch must pin the lead too -- a URL whose lead id does not constrain the event it names is a trap for the next caller`,
  );
  assert.match(patchCode, /\.eq\("id", args\.eventId\)/, `${EVENTS} patch must still pin the event id`);
  assert.match(
    patchCode,
    /safeFilterValue\(args\.leadRecordId/,
    `${EVENTS} patch must charset-allowlist the lead id before it reaches the PostgREST filter`,
  );
  assert.match(
    eventRoute,
    /\{ eventId, leadRecordId: id \}/,
    `${EVENT_ROUTE} must pass the lead from its OWN url as the patch scope`,
  );
}

// ---------------------------------------------------------------------------
// 4. THE CONSOLE READ IS SCOPED TO THE CURRENT CALL. Final review, BLOCKING 3:
// an unbounded history read plus `logged = Boolean(existingEvent)` made
// "Logged" permanent for the life of the lead, so from the second call onward
// a rep could not record an objection coming up again -- which under-counts
// exactly the recurring objections the scoreboard exists to rank.
// ---------------------------------------------------------------------------
{
  const fetchFn = exportedFn(events, "fetchLeadEvents");
  assert.ok(fetchFn.length > 0, `${EVENTS} must export fetchLeadEvents`);
  assert.match(events, /export const SAME_CALL_WINDOW_MINUTES = \d+;/, `${EVENTS} must name the call window as a constant`);
  assert.match(
    stripComments(fetchFn),
    /\.gte\("occurred_at", since\)/,
    `${EVENTS} must bound the console's event read to the current call -- an unbounded read makes "Logged" permanent`,
  );
  assert.match(
    stripComments(fetchFn),
    /SAME_CALL_WINDOW_MINUTES \* 60_000/,
    `${EVENTS}'s cutoff must be derived from SAME_CALL_WINDOW_MINUTES, not a second number typed inline`,
  );
}

// ---------------------------------------------------------------------------
// 5. THE APPROVAL FILTER IS THE FEATURE'S MOST IMPORTANT RULE, and it must be
// enforced in the PURE projection as well as in the query builder -- a rule
// that lives only in a `.eq()` is a rule a refactor of the query deletes with
// nothing noticing. The behavioural half is
// tests/objection-catalog.test.ts (draft and retired rows planted, proved to
// fire); this half pins that both layers exist at all.
// ---------------------------------------------------------------------------
{
  const code = stripComments(catalog);
  assert.match(code, /if \(o\.status !== "approved"\) continue;/, `${CATALOG}: assembleCatalog must drop non-approved OBJECTIONS`);
  assert.match(code, /if \(r\.status !== "approved"\) continue;/, `${CATALOG}: assembleCatalog must drop non-approved ANSWERS`);
  assert.match(code, /\.eq\("status", "approved"\)/, `${CATALOG}: the catalog query must also filter on approved`);
}

// ---------------------------------------------------------------------------
// 6. Both migrations carry the pin and the shape the code above relies on.
// ---------------------------------------------------------------------------
{
  const migration = read(MIGRATION);
  assert.match(migration, /tenant_id\s+text not null/, `${MIGRATION} must make tenant_id mandatory on every table`);
  assert.match(migration, /unique\s+index[\s\S]{0,200}?objection_event_request_uq/i, `${MIGRATION} must enforce request-id uniqueness in the database`);
  assert.match(migration, /lead_record_id/, `${MIGRATION} must carry the lead pointer the PATCH scopes on`);
  assert.match(
    read(PREMISE_MIGRATION),
    /ALTER TABLE objection_catalog ADD COLUMN website_premise text/,
    `${PREMISE_MIGRATION} must add the ranking premise column`,
  );
}

// ---------------------------------------------------------------------------
// 7. No em dashes in anything a rep can read (project rule: they flag
// AI-generated text). Comments are stripped first, same as the sibling.
// `--` is not the workaround either: seeded copy renders verbatim on the card,
// so a literal double hyphen reaches a rep as two hyphens.
// ---------------------------------------------------------------------------
for (const label of [CARD, CONSOLE_VIEW, COLLECTION_ROUTE, EVENT_ROUTE, CATALOG, EVENTS]) {
  const dashes = stripComments(read(label)).match(/.{0,50}[—–].{0,50}/g) || [];
  assert.deepEqual(dashes, [], `em/en dash found in ${label}: ${dashes.join(" | ")}`);
}
{
  const seed = read("scripts/seed-objection-catalog.ts");
  // Only the copy that reaches a card: the string literals inside the two
  // metadata blocks and the meaning/prevent fields written beside them. `--`
  // in a comment or in an argv flag (`--dry-run`) is not rep-facing.
  // Single-line double-quoted literals only. A pattern allowing newlines runs
  // straight through the file's template-literal error messages and reports
  // whatever `--` it finds in a comment or an argv flag as rep-facing copy.
  const repFacing = [...stripComments(seed).matchAll(/"((?:[^"\\\n]|\\.){40,})"/g)].map((m) => m[1]);
  assert.ok(repFacing.length >= 10, `expected the seed's rep-facing copy strings, found ${repFacing.length}`);
  for (const copy of repFacing) {
    assert.ok(!copy.includes("--"), `seeded rep-facing copy must not use "--" as a dash substitute: ${copy.slice(0, 80)}`);
    assert.ok(!/[—–]/.test(copy), `seeded rep-facing copy must not contain an em/en dash: ${copy.slice(0, 80)}`);
  }
}

console.log("objection-guards: OK");
