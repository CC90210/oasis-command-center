/**
 * sunbiz-restore-behaviour.test.ts — three changes written for OASIS that also
 * changed what SunBiz's users see. Each is put back for SunBiz and kept for
 * OASIS:
 *
 *   (a) #401       the drawer email composer saved a typed address over the
 *                  merchant's email of record, on the lead AND (through
 *                  set-field's mirror) the linked application.
 *   (b) #405/#421  merchant email started copying the lead's rep and the sender.
 *   (c) #405       the Kixie PowerList stopped falling back to the business name.
 *
 * Every rule is exercised for BOTH companies through the real brand map
 * (lib/email/brand-for-tenant.ts). A fix proven only for SunBiz could quietly
 * take OASIS's behaviour away, and the reverse is exactly what happened here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brandForTenant } from "../lib/email/brand-for-tenant";
import { savesTypedRecipient, typedRecipientNote } from "../lib/leads/typed-recipient";
import {
  buildCopyList,
  finalizeCopyList,
  leadEmailCopiesReps,
} from "../lib/leads/lead-copy-recipients";
import { contactNameFor, powerlistContactNameFor } from "../lib/leads/canonical-lead-fields";
import { buildGmailRawMessage } from "../lib/integrations/gmail-oauth-send";

const SUNBIZ_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("sunbiz-restore-behaviour:");

// ---- (a) the drawer email composer -----------------------------------------

run("(a) SunBiz's composer never saves a typed address; OASIS's still does", () => {
  // Every slug each portal is reached by (lib/portals/registry.ts tenantSlugs,
  // plus the scraped-prospect workspace). The drawer mounts pass "sun".
  for (const slug of ["sun", "sunbiz", "submissions"]) {
    assert.equal(savesTypedRecipient(slug), false, `SunBiz slug "${slug}" would overwrite the email of record`);
  }
  for (const slug of ["oasis", "oasis-ai-cc", "oasis-webdev"]) {
    assert.equal(savesTypedRecipient(slug), true, `OASIS slug "${slug}" lost #401's save`);
  }
});

run("(a) a workspace the brand map does not know saves nothing", () => {
  // Includes the self-signup tenant that merely shares SunBiz's prefix, and a
  // prototype key that a naive lookup would resolve to a truthy function.
  for (const slug of ["", null, undefined, "submissions-5f63d7e6", "constructor", "yoga-tantric"]) {
    assert.equal(savesTypedRecipient(slug), false, `unknown slug ${String(slug)} saved an address`);
  }
});

run("(a) the note under the recipient says what will actually happen", () => {
  const sunbiz = savesTypedRecipient("sun");
  const changed = typedRecipientNote({ saves: sunbiz, hasAddressOnFile: true });
  const fresh = typedRecipientNote({ saves: sunbiz, hasAddressOnFile: false });
  for (const note of [changed, fresh]) {
    assert.doesNotMatch(note, /it'll be saved/, `SunBiz note promises a save that no longer happens: ${note}`);
  }
  assert.match(changed, /won't change/, "SunBiz note does not say the email on file is left alone");
  assert.match(fresh, /this send only/, "SunBiz note does not say the typed address is not kept");

  // OASIS keeps #401's words exactly.
  const oasis = savesTypedRecipient("oasis-ai-cc");
  assert.equal(
    typedRecipientNote({ saves: oasis, hasAddressOnFile: true }),
    "Sending to a different address than the one on file — it'll be saved to this lead.",
  );
  assert.equal(
    typedRecipientNote({ saves: oasis, hasAddressOnFile: false }),
    "New address — it'll be saved to this lead so the next person isn't stuck.",
  );
});

run("(a) the composer's save and its note hang off the same tenant answer", () => {
  const src = readFileSync("components/leads/LeadFileBody.tsx", "utf8");
  assert.match(src, /<DrawerFooter\s+tenantSlug=\{tenantSlug\}/, "the drawer's tenant never reaches the footer");
  assert.match(src, /<EmailComposer\s+tenantSlug=\{tenantSlug\}/, "the drawer's tenant never reaches the composer");
  assert.match(src, /const savesTyped = savesTypedRecipient\(tenantSlug\)/, "the save is not decided by tenant");
  assert.match(
    src,
    /typedRecipientNote\(\{ saves: savesTyped, hasAddressOnFile: Boolean\(toEmail\) \}\)/,
    "the warning is not chosen from the same answer as the save",
  );
  // The only implicit email write in the composer, and it sits behind the gate.
  const writes = src.match(/JSON\.stringify\(\{ key: "email", value: recipient \}\)/g) || [];
  assert.equal(writes.length, 1, "expected exactly one composer write of the email field");
  assert.match(
    src,
    /if \(isNewAddress && savesTyped\) \{\s*try \{\s*const sf = await fetch\(`\/api\/leads\/\$\{recordId\}\/set-field`/,
    "the set-field write is not gated on the tenant",
  );
  // The hard-coded promise must be gone from the component; it lives in the helper.
  assert.doesNotMatch(src, /it'll be saved to this lead/, "LeadFileBody still hard-codes the save promise");
});

// ---- (b) who a lead email copies --------------------------------------------

const MERCHANT = "owner@acmepaving.example";
const REP = "rep@sunbizfunding.com";
const SENDER = "ops@sunbizfunding.com";

run("(b) SunBiz merchant email copies nobody; OASIS copies the rep, then the sender", () => {
  const sunbiz = brandForTenant({ tenantId: SUNBIZ_TENANT_ID });
  const oasis = brandForTenant({ tenantId: OASIS_TENANT_ID });
  assert.equal(sunbiz, "sunbiz");
  assert.equal(oasis, "oasis");

  assert.equal(leadEmailCopiesReps(sunbiz), false, "SunBiz merchant mail copies the rep and sender again");
  assert.equal(leadEmailCopiesReps(oasis), true, "OASIS lost the rep copy #405/#421 added");
  for (const other of ["bluerise", null, undefined, ""]) {
    assert.equal(leadEmailCopiesReps(other), false, `brand ${String(other)} copies reps`);
  }

  // What the OASIS side still produces, through the real list builder.
  const oasisRep = "schneur@oasisai.work";
  const oasisSender = "conaugh@oasisai.work";
  assert.deepEqual(
    buildCopyList({ assignedRepEmail: oasisRep, senderEmail: oasisSender, toEmail: "owner@broadway.example" }),
    [oasisRep, oasisSender],
  );
});

run("(b) the route builds the copy list, and looks up the assignee, only when copying", () => {
  const route = readFileSync("app/api/leads/[id]/email/route.ts", "utf8");
  // The list starts empty and is only ever filled inside the brand gate.
  assert.match(
    route,
    /let copyList: string\[\] = \[\];\s*if \(leadEmailCopiesReps\(brand\)\) \{/,
    "the copy list is not gated on the brand rule",
  );
  // One assignment, the one inside the gate; a second would bypass it.
  assert.equal((route.match(/copyList = /g) || []).length, 1, "copyList is assigned somewhere outside the gate");

  // The lead read and the roster lookup exist for the copy alone; on SunBiz they
  // must not run, or a failed lookup reaches the rep as a tracking warning that
  // SunBiz never had.
  const gate = route.indexOf("if (leadEmailCopiesReps(brand)) {");
  const built = route.indexOf("copyList = buildCopyList(");
  assert.ok(gate > 0 && built > gate, "no brand gate before the copy list is built");
  const gated = route.slice(gate, built);
  assert.match(gated, /resolveAssigneeEmail\(/, "assignee lookup is outside the gate");
  assert.match(gated, /\.from\("tenant_records"\)/, "lead read is outside the gate");
  assert.equal((route.match(/resolveAssigneeEmail\(/g) || []).length, 1, "a second assignee lookup appeared");
  assert.equal((route.match(/\.from\("tenant_records"\)/g) || []).length, 1, "a second lead read appeared");

  // Every transport takes its Cc from that one list, so [] reaches all of them.
  const ccValues = [...route.matchAll(/\bcc: ([A-Za-z_.]+)/g)].map((m) => m[1]);
  assert.ok(ccValues.length >= 4, `expected every transport to pass cc, saw ${ccValues.length}`);
  for (const v of ccValues) {
    assert.ok(v === "copyList" || v === "args.cc", `a transport takes its Cc from ${v}, not the gated list`);
  }
});

run("(b) an empty copy list puts no Cc header on the merchant's email", () => {
  // The operator transports finalize the list and add a Cc only when it is
  // non-empty; the bridge forwards cc only when args.cc.length is non-zero.
  const cc = finalizeCopyList([], { to: MERCHANT, fromAddress: REP });
  assert.deepEqual(cc, []);
  const raw = buildGmailRawMessage({
    from: REP,
    to: MERCHANT,
    ...(cc.length ? { cc: cc.join(", ") } : {}),
    subject: "Your application",
    body: "Hi",
  });
  const headers = Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n")[0];
  assert.doesNotMatch(headers, /^Cc:/im, "a SunBiz merchant email still carries a Cc header");
  assert.ok(!headers.includes(SENDER));
});

// ---- (c) the name Kixie shows ------------------------------------------------

run("(c) SunBiz's dialer falls back to the business name, exactly as before #405", () => {
  const sunbiz = brandForTenant({ tenantId: SUNBIZ_TENANT_ID });
  assert.equal(powerlistContactNameFor({ business_name: "Acme Paving LLC" }, sunbiz), "Acme Paving LLC");
  assert.equal(
    powerlistContactNameFor({ contact_name: "Dana Ruiz", business_name: "Acme Paving LLC" }, sunbiz),
    "Dana Ruiz",
  );
  // The pre-#405 expression was contact_name || business_name. It never read
  // owner_name or name, so neither may change a SunBiz dialer entry now.
  assert.equal(powerlistContactNameFor({ owner_name: "Rita Owens", business_name: "Acme" }, sunbiz), "Acme");
  assert.equal(powerlistContactNameFor({ name: "Jean Tremblay", business_name: "Acme" }, sunbiz), "Acme");
  assert.equal(powerlistContactNameFor({ contact_name: "  ", business_name: " Acme " }, sunbiz), "Acme");
  assert.equal(powerlistContactNameFor({}, sunbiz), "");
});

run("(c) OASIS's dialer still names a person or nobody, never the business", () => {
  const oasis = brandForTenant({ tenantId: OASIS_TENANT_ID });
  const board = { name: "Divine Flooring", company: "Divine Flooring", business_name: "Divine Flooring" };
  assert.equal(powerlistContactNameFor(board, oasis), "", "the OASIS dialer names the business again");
  assert.equal(powerlistContactNameFor({ ...board, owner_name: "Carlos Soares" }, oasis), "Carlos Soares");
  const leads: Record<string, unknown>[] = [
    board,
    { ...board, owner_name: "Carlos Soares" },
    { contact_name: "Maria Gonzalez", owner_name: "X", business_name: "Y" },
    { name: "Jean Tremblay" },
    {},
  ];
  for (const lead of leads) assert.equal(powerlistContactNameFor(lead, oasis), contactNameFor(lead));
});

run("(c) a tenant the brand map does not know keeps the pre-#405 name", () => {
  const stranger = brandForTenant({ tenantId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(stranger, null);
  assert.equal(powerlistContactNameFor({ business_name: "Acme" }, stranger), "Acme");
});

run("(c) the PowerList route resolves the brand from the tenant id and uses the rule", () => {
  const route = readFileSync("app/api/leads/powerlist/route.ts", "utf8");
  assert.match(route, /const brand = brandForTenant\(\{ tenantId \}\)/, "the route does not resolve the tenant's brand");
  assert.match(route, /const nameSrc = powerlistContactNameFor\(data, brand\)/, "the route bypasses the per-brand rule");
  assert.doesNotMatch(route, /\bcontactNameFor\(/, "the route calls the OASIS-only helper directly");
});

console.log("sunbiz-restore-behaviour: all passed");
