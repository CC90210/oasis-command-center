/**
 * lead-contact-name.test.ts — the field labelled "Contact name" must hold a PERSON.
 *
 * THE DEFECT (measured live 2026-09-08). The pipeline's Contact name field, and
 * the contact seeded into the founder-meeting Google Calendar invite, both read
 * `data.name`. On the OASIS web-leads board the OSM promoter writes
 * name = company = business_name, so 1,684 of the 1,685 owner-named leads
 * displayed the COMPANY in a person-shaped field while `owner_name` held a real
 * person and `contact_name` sat empty on all 1,853 of them.
 *
 * The cost was not cosmetic. A rep reading "HVAC Mechanical Systems Inc" under
 * "Contact name" concluded we had no owner and asked for a full re-scrape of
 * data we already had — and a Calendar invite went out addressed to a company.
 *
 * Two directions are pinned here, because a fix that only satisfies OASIS would
 * break SunBiz, where `name` genuinely IS the person.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contactNameFor, hasNamedContact } from "../lib/leads/canonical-lead-fields";
import { REP_EDITABLE_LEAD_FIELDS } from "../lib/oasis-sales-pipeline-policy";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("lead-contact-name:");

run("the OASIS shape returns the OWNER, never the company", () => {
  // Verbatim shape of a real board lead: name == company == business_name.
  const lead = {
    name: "Divine Flooring",
    company: "Divine Flooring",
    business_name: "Divine Flooring",
    owner_name: "Carlos Soares",
    owner_title: "founder",
  };
  assert.equal(contactNameFor(lead), "Carlos Soares");
  assert.ok(hasNamedContact(lead));
});

run("a company name is NEVER returned as a contact", () => {
  // No owner known. "" is the honest answer — a business name in a
  // person-shaped field is a sentence a rep says out loud on a live call.
  const lead = { name: "HVAC Mechanical Systems Inc", company: "HVAC Mechanical Systems Inc" };
  assert.equal(contactNameFor(lead), "");
  assert.equal(hasNamedContact(lead), false);
});

run("suffix and punctuation differences do not sneak the company through", () => {
  for (const [name, company] of [
    ["Coastline Auto Detailing Ltd.", "Coastline Auto Detailing Ltd"],
    ["coastline auto detailing", "Coastline Auto Detailing"],
    ["Buff-It Detailing, Collingwood", "Buff It Detailing Collingwood"],
    ["  Sacred Heart Tattoo  ", "Sacred Heart Tattoo"],
  ] as const) {
    assert.equal(contactNameFor({ name, company }), "", `leaked company: ${name}`);
  }
});

run("the SunBiz shape still works — `name` is a real person there", () => {
  // This is why `name` is a conditional fallback rather than dropped. Breaking
  // it would empty the contact field across the other pipeline.
  const lead = { name: "Maria Gonzalez", company: "Sunshine Landscaping LLC" };
  assert.equal(contactNameFor(lead), "Maria Gonzalez");
  assert.ok(hasNamedContact(lead));
});

run("precedence: a human correction beats the scraped owner", () => {
  const lead = {
    contact_name: "Marc (the son, runs it now)",
    owner_name: "Robert Lefebvre",
    name: "Coastline Auto Detailing",
    company: "Coastline Auto Detailing",
  };
  assert.equal(contactNameFor(lead), "Marc (the son, runs it now)");

  // ...and the scraped owner beats a company-shaped `name`.
  assert.equal(
    contactNameFor({ owner_name: "Robert Lefebvre", name: "X Ltd", company: "X Ltd" }),
    "Robert Lefebvre",
  );
});

run("junk input degrades to empty, never throws", () => {
  assert.equal(contactNameFor({}), "");
  assert.equal(contactNameFor({ name: null, company: undefined }), "");
  assert.equal(contactNameFor({ name: 42, owner_name: { nope: true } }), "");
  assert.equal(contactNameFor({ owner_name: "   " }), "");
  // company absent: a lone `name` has nothing to collide with, so it stands.
  assert.equal(contactNameFor({ name: "Jean Tremblay" }), "Jean Tremblay");
});

run("a rep can actually SAVE the field the editor now writes", () => {
  // The editor writes contact_name. rejectedRepPatchKeys() is an ALLOWLIST
  // check, so without this entry the field renders, accepts typing, and 400s on
  // save — which reads to the rep as their own mistake.
  assert.ok(
    REP_EDITABLE_LEAD_FIELDS.has("contact_name"),
    "contact_name missing from REP_EDITABLE_LEAD_FIELDS — every rep save would be rejected",
  );
});

run("the surfaces are wired to the helper, not to data.name", () => {
  const editor = readFileSync("components/leads/LeadContextEditor.tsx", "utf8");
  assert.match(editor, /contact_name: contactNameFor\(data\)/, "editor does not seed from the helper");
  assert.match(
    editor,
    /label="Contact name"[\s\S]{0,120}state\.contact_name/,
    "the Contact name field is not bound to contact_name",
  );
  // Writing `name` here would overwrite the BUSINESS identity that the lead
  // title, the audit band and bulk-email recipients all read.
  assert.ok(
    !/set\("name",/.test(editor),
    "the editor still writes data.name — that is the business identity",
  );

  const page = readFileSync("app/pipeline/[id]/page.tsx", "utf8");
  assert.match(
    page,
    /leadName=\{nonEmptyString\(contactNameFor\(activeRecord\.data\)\)\}/,
    "the founder-meeting invite still seeds its contact from data.name",
  );
});
