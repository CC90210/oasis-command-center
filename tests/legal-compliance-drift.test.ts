/**
 * Guards the public legal pages against becoming false statements.
 *
 * /privacy asserts, in prose, that this app loads no third-party analytics SDK
 * and that it shares data with exactly the listed subprocessors. Both claims
 * are hand-maintained in lib/legal/constants.ts and duplicated into
 * docs/compliance/PRIVACY_NUTRITION_LABEL.json for app-store declarations.
 *
 * Nothing in the type system keeps those two in step with each other, or with
 * what the app actually does. The realistic failure is mundane: someone adds
 * `@vercel/analytics` in a perf sprint, and a legal page silently starts
 * telling users there is no analytics SDK. That is a compliance defect, not a
 * stale comment — so it fails here instead.
 *
 * Sections 4-7 were added on 2026-09-28 because that already happened, the
 * other way round. The database moved from Supabase to Turso and hosting from
 * Vercel to Cloudflare, and for seven weeks /privacy kept naming Supabase and
 * Vercel as the processors holding everyone's data, kept telling users their
 * workspace was isolated by "row-level security" (Turso has no such feature;
 * isolation is tenant_id filters in application code), cited an audit document
 * that was never committed, and named no Law 25 privacy officer. So:
 *   4. every processor is pinned to the code that proves it is in use, in both
 *      directions, and every outbound API host in the app must be classified;
 *   5. no public legal surface may claim database-enforced row isolation;
 *   6. every repository document a legal surface cites must exist;
 *   7. the Law 25 person in charge must be named and rendered.
 *
 * Run: node --conditions=react-server --import tsx tests/legal-compliance-drift.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as legal from "@/lib/legal/constants";
import { getDataBackendMode } from "@/lib/backend-mode";

const { SUBPROCESSORS, DATA_MATRIX, LEGAL_CONTACTS, PRIVACY_OFFICER } = legal;

const root = join(__dirname, "..");

const LABEL_PATH = "docs/compliance/PRIVACY_NUTRITION_LABEL.json";
const labelText = readFileSync(join(root, LABEL_PATH), "utf8");
const label = JSON.parse(labelText) as {
  app: {
    privacyContact: string;
    privacyOfficer: { name: string; title: string; titleFr: string; email: string };
  };
  userRights: { requestChannel: string };
  tracking: { thirdPartyAnalyticsSdks: unknown[]; advertisingPixels: unknown[] };
  subprocessors: { name: string; dpaInPlace: boolean }[];
  dataCollected: {
    category: string;
    sensitive: boolean;
    sharedWith?: string[];
    formerRecipients?: string[];
    retention?: string;
  }[];
  legacyDataLocations?: { name: string; status: string }[];
  openGaps?: string[];
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// 1. The "no third-party analytics" claim on /privacy must still be true.
// ---------------------------------------------------------------------------

const ANALYTICS_PACKAGES = [
  "@vercel/analytics",
  "@vercel/speed-insights",
  "posthog-js",
  "posthog-node",
  "mixpanel-browser",
  "@amplitude/analytics-browser",
  "react-ga",
  "react-ga4",
  "@sentry/nextjs",
  "@segment/analytics-next",
  "plausible-tracker",
];

const installedAnalytics = Object.keys({
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {}),
}).filter((d) => ANALYTICS_PACKAGES.includes(d));

assert.deepEqual(
  installedAnalytics,
  [],
  `An analytics/telemetry package was added (${installedAnalytics.join(", ")}), but ` +
    `app/(marketing)/privacy/page.tsx section 4 still tells users this app loads no third-party ` +
    `analytics SDK. Update that section, add the processor to SUBPROCESSORS in ` +
    `lib/legal/constants.ts, and add it to tracking.thirdPartyAnalyticsSdks in ` +
    `PRIVACY_NUTRITION_LABEL.json — then add it to this allowlist.`,
);

assert.deepEqual(
  label.tracking.thirdPartyAnalyticsSdks,
  [],
  "PRIVACY_NUTRITION_LABEL.json lists an analytics SDK while /privacy claims there is none.",
);

assert.deepEqual(
  label.tracking.advertisingPixels,
  [],
  "PRIVACY_NUTRITION_LABEL.json lists an advertising pixel while /privacy claims there is none.",
);

// ---------------------------------------------------------------------------
// 2. The rendered subprocessor table and the JSON manifest must agree.
//    A processor disclosed on one surface but not the other is the exact gap
//    a regulator reads as an undisclosed transfer.
// ---------------------------------------------------------------------------

const fromConstants = SUBPROCESSORS.map((s) => s.name).sort();
const fromLabel = label.subprocessors.map((s) => s.name).sort();

assert.deepEqual(
  fromLabel,
  fromConstants,
  "Subprocessor lists disagree between lib/legal/constants.ts (rendered on /privacy) " +
    "and docs/compliance/PRIVACY_NUTRITION_LABEL.json (used for app-store declarations).",
);

for (const s of SUBPROCESSORS) {
  const mirrored = label.subprocessors.find((l) => l.name === s.name);
  assert.ok(mirrored, `${s.name} missing from the JSON manifest`);
  assert.equal(
    mirrored.dpaInPlace,
    s.dpaInPlace,
    `DPA status for ${s.name} disagrees between the privacy page and the JSON manifest. ` +
      `These drive different published claims and must match.`,
  );
}

// ---------------------------------------------------------------------------
// 3. Sensitive categories must stay flagged on both surfaces.
//    SSN / DOB / EIN are sensitive personal information under Quebec Law 25
//    and the CPRA; silently dropping the flag downgrades the consent standard
//    the product is representing to users.
// ---------------------------------------------------------------------------

const sensitiveInConstants = DATA_MATRIX.filter((d) => d.sensitive).length;
const sensitiveInLabel = label.dataCollected.filter((d) => d.sensitive).length;

assert.equal(
  sensitiveInLabel,
  sensitiveInConstants,
  `The privacy page flags ${sensitiveInConstants} sensitive data categories but the ` +
    `JSON manifest flags ${sensitiveInLabel}. Sensitive-data handling drives the consent ` +
    `standard — the two surfaces must not disagree.`,
);

assert.ok(
  sensitiveInConstants > 0,
  "No sensitive category is flagged at all. This app collects ssn/dob/ein via the " +
    "funding funnel — if that genuinely stopped being true, delete this assertion " +
    "deliberately rather than letting it pass silently.",
);

// ---------------------------------------------------------------------------
// 4. The subprocessor list matches the deployed stack.
//
//    (a) Each listed processor is pinned to code that proves the app uses it.
//        Evidence gone = the integration moved or was removed: find out which,
//        then update the list (and the JSON manifest) or the evidence here.
//    (b) Each processor with evidence is listed, and nothing is listed without
//        evidence — so the table can neither miss a provider nor keep a dead one.
//    (c) Every outbound API host in app/, lib/ and components/ is classified as
//        a listed processor or as an exemption with a stated reason, so wiring
//        a NEW provider fails here until someone decides whether it receives
//        personal information.
// ---------------------------------------------------------------------------

function source(rel: string): string {
  const p = join(root, rel);
  assert.ok(existsSync(p), `Evidence file ${rel} no longer exists — see section 4 of this test.`);
  return readFileSync(p, "utf8");
}

type Evidence = { file: string; proof: RegExp; what: string };

const STACK_EVIDENCE: Record<string, Evidence[]> = {
  Turso: [
    { file: "package.json", proof: /"@libsql\/client"/, what: "the libSQL client dependency" },
  ],
  "Cloudflare, Inc.": [
    { file: "wrangler.jsonc", proof: /"DEPLOY_PLATFORM":\s*"cloudflare"/, what: "the Workers deploy config" },
    { file: "lib/r2-storage.ts", proof: /process\.env\.R2_BUCKET/, what: "R2 object storage" },
  ],
  "Anthropic PBC": [
    { file: "lib/providers.ts", proof: /https:\/\/api\.anthropic\.com\//, what: "the Claude API adapter" },
  ],
  "OpenAI, L.L.C.": [
    { file: "lib/providers.ts", proof: /https:\/\/api\.openai\.com\//, what: "the GPT API adapter" },
  ],
  OpenRouter: [
    { file: "lib/providers.ts", proof: /https:\/\/openrouter\.ai\/api\//, what: "the OpenRouter adapter" },
  ],
  "Google LLC": [
    { file: "lib/providers.ts", proof: /generativelanguage\.googleapis\.com/, what: "the Gemini adapter" },
    { file: "lib/integrations/gmail-oauth-send.ts", proof: /gmail\.googleapis\.com/, what: "Gmail sending" },
    { file: "lib/integrations/google-calendar.ts", proof: /googleapis\.com\/calendar/, what: "Calendar events" },
  ],
  Stripe: [
    { file: "lib/website-sales-payment.ts", proof: /https:\/\/api\.stripe\.com\//, what: "Stripe Checkout" },
  ],
  "Twilio Inc.": [
    { file: "lib/sms-direct-twilio.ts", proof: /https:\/\/api\.twilio\.com\//, what: "SMS dispatch" },
  ],
  Telegram: [
    { file: "lib/notify/telegram.ts", proof: /https:\/\/api\.telegram\.org\//, what: "staff alerts" },
  ],
};

for (const [processor, evidence] of Object.entries(STACK_EVIDENCE)) {
  for (const e of evidence) {
    assert.match(
      source(e.file),
      e.proof,
      `${processor} is disclosed on /privacy because of ${e.what} in ${e.file}, but that ` +
        `code is gone. If the integration was removed, remove ${processor} from SUBPROCESSORS ` +
        `and ${LABEL_PATH}; if it moved, point this evidence at its new home.`,
    );
  }
  assert.ok(
    SUBPROCESSORS.some((s) => s.name === processor),
    `The app uses ${processor} (${evidence.map((e) => e.what).join(", ")}) but /privacy does ` +
      `not list it. An undisclosed processor is an undisclosed transfer — add it to ` +
      `SUBPROCESSORS in lib/legal/constants.ts and to ${LABEL_PATH}.`,
  );
}

for (const s of SUBPROCESSORS) {
  assert.ok(
    STACK_EVIDENCE[s.name],
    `/privacy lists "${s.name}" as a processor, but nothing in this test ties it to code the ` +
      `app runs. Either it is no longer used (remove it) or add its evidence to STACK_EVIDENCE.`,
  );
}

// The platform the policy describes must be the platform the app runs on. If
// either default flips back, the processor table is wrong again.
assert.equal(
  getDataBackendMode({}),
  "turso",
  "The default data backend is no longer Turso — /privacy names Turso as the database. " +
    "Update SUBPROCESSORS and the JSON manifest to the new backend.",
);

const RETIRED_PROCESSOR = /supabase|vercel/i;
for (const s of SUBPROCESSORS) {
  assert.doesNotMatch(
    `${s.name} ${s.role} ${s.dataReceived} ${s.region} ${s.note ?? ""}`,
    RETIRED_PROCESSOR,
    `SUBPROCESSORS entry "${s.name}" names Supabase or Vercel. The app runs on Turso and ` +
      `Cloudflare; the legacy Supabase copy is disclosed separately on /privacy section 6.`,
  );
}
// Retired is not deleted: both former providers still hold data from the
// period they served (Supabase a full legacy copy, Vercel request logs and
// build artifacts), so /privacy must disclose them until the accounts close.
// Dropping them from the live table must not drop them from the page
// (Codex review, 2026-09-28).
{
  const privacyPage = readFileSync(join(root, "app/(marketing)/privacy/page.tsx"), "utf8");
  assert.match(privacyPage, /Former database provider[\s\S]*Supabase/, "/privacy must disclose the legacy Supabase copy");
  assert.match(privacyPage, /Former hosting provider[\s\S]*Vercel/, "/privacy must disclose the former Vercel hosting and its retained logs");

  // The JSON manifest must disclose the same former holders the page does, or
  // an app-store declaration omits a party still holding personal data
  // (CodeRabbit on #465).
  const legacy = (label.legacyDataLocations ?? []).map((l) => l.name).join(" | ");
  assert.match(legacy, /Supabase/, `${LABEL_PATH} legacyDataLocations must list the legacy Supabase copy /privacy discloses.`);
  assert.match(legacy, /Vercel/, `${LABEL_PATH} legacyDataLocations must list Vercel, which /privacy says still holds request logs.`);
  const diagnostics = label.dataCollected.find((d) => /diagnostic/i.test(d.category));
  assert.ok(diagnostics, `${LABEL_PATH} has no diagnostics category.`);
  assert.ok(
    (diagnostics.formerRecipients ?? []).some((r) => /Vercel/.test(r)),
    `${LABEL_PATH} diagnostics must name Vercel as a former recipient of request logs.`,
  );
  assert.match(
    diagnostics.retention ?? "",
    /Vercel/,
    `${LABEL_PATH} diagnostics retention must state what applies to the logs Vercel still holds.`,
  );
}
for (const d of DATA_MATRIX) {
  assert.doesNotMatch(
    d.sharedWith,
    RETIRED_PROCESSOR,
    `DATA_MATRIX "${d.category}" says the data is shared with Supabase or Vercel — neither ` +
      `receives it any more.`,
  );
}
for (const s of label.subprocessors) {
  assert.doesNotMatch(s.name, RETIRED_PROCESSOR, `${LABEL_PATH} still lists ${s.name} as a subprocessor.`);
}
for (const d of label.dataCollected) {
  for (const w of d.sharedWith ?? []) {
    assert.doesNotMatch(
      w,
      RETIRED_PROCESSOR,
      `${LABEL_PATH} "${d.category}" still says the data is shared with ${w}.`,
    );
  }
}

/**
 * Outbound API hosts that are NOT listed processors, and why. A host belongs
 * here only if it receives no personal information from a live workspace.
 * "SunBiz only" hosts leave with the SunBiz retirement track; if one is
 * re-enabled for a live tenant it must move to SUBPROCESSORS instead.
 */
const EXEMPT_HOSTS: Record<string, string> = {
  "api.texttorrent.com": "SunBiz only (retired tenant): SMS provider",
  "apig.kixie.com": "SunBiz only (retired tenant): dialer",
  "api.cc.email": "SunBiz only (retired tenant): Constant Contact blasts",
  "server.smartlead.ai": "SunBiz only (retired tenant): cold-email blasts",
  "api.mapbox.com": "SunBiz merchant application form only: address lookup fallback",
  "api.github.com": "reads OASIS's own repositories for agent knowledge; sends no personal information",
  "api.transferwise.com": "OASIS's own business bank account (founders' finances); sends no customer data",
  "api.typesafe.ai":
    "Jev (TypeSafe): only the key check runs (list models, no data) while lib/jev/mode.ts JEV_TEXT_PROCESSING_APPROVED is false; flipping it needs TypeSafe on /privacy (asserted below)",
};

// Jev may classify workspace text only in the same change that lists TypeSafe
// as a processor: the exemption above is true only while the gate is shut.
{
  const jevMode = readFileSync(join(root, "lib/jev/mode.ts"), "utf8");
  const gate = /export const JEV_TEXT_PROCESSING_APPROVED = (true|false);/.exec(jevMode);
  assert.ok(gate, "lib/jev/mode.ts lost its JEV_TEXT_PROCESSING_APPROVED gate: TypeSafe could receive text unlisted.");
  if (gate[1] === "true") {
    assert.ok(
      SUBPROCESSORS.some((s) => /TypeSafe/i.test(s.name)),
      "Jev classifies workspace text (JEV_TEXT_PROCESSING_APPROVED = true) but TypeSafe is not on /privacy.",
    );
    assert.fail("Remove api.typesafe.ai from EXEMPT_HOSTS and map it to TypeSafe in HOST_TO_PROCESSOR: it now receives text.");
  }
}

const HOST_TO_PROCESSOR: Record<string, string> = {
  "api.anthropic.com": "Anthropic PBC",
  "api.openai.com": "OpenAI, L.L.C.",
  "api.stripe.com": "Stripe",
  "api.twilio.com": "Twilio Inc.",
  "api.telegram.org": "Telegram",
};

function processorForHost(host: string): string | null {
  if (HOST_TO_PROCESSOR[host]) return HOST_TO_PROCESSOR[host];
  if (host.endsWith(".googleapis.com")) return "Google LLC";
  return null;
}

/** Hosts shaped like an API endpoint: api.*, apig.*, server.*, *.googleapis.com. */
const API_HOST = /https:\/\/((?:api|apig|server)\.[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9-]+\.googleapis\.com)/gi;

function walk(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name))
    .map((d) => join(d.parentPath, d.name));
}

const hostsSeen = new Map<string, string>();
for (const dir of ["app", "lib", "components"]) {
  for (const file of walk(dir)) {
    for (const m of readFileSync(file, "utf8").matchAll(API_HOST)) {
      const host = m[1].toLowerCase();
      if (!hostsSeen.has(host)) hostsSeen.set(host, file.slice(root.length + 1));
    }
  }
}

assert.ok(
  hostsSeen.has("api.anthropic.com") && hostsSeen.has("api.stripe.com"),
  "The outbound-host scan found neither the Claude nor the Stripe API — the scan itself is " +
    "broken (wrong root or pattern), so its silence below would prove nothing.",
);

for (const [host, file] of hostsSeen) {
  if (EXEMPT_HOSTS[host]) continue;
  const processor = processorForHost(host);
  assert.ok(
    processor,
    `${file} calls ${host}, which is neither a listed processor nor an exemption. If it ` +
      `receives personal information, add it to SUBPROCESSORS and ${LABEL_PATH} (and ` +
      `STACK_EVIDENCE here); if it does not, add it to EXEMPT_HOSTS with the reason.`,
  );
  assert.ok(
    SUBPROCESSORS.some((s) => s.name === processor),
    `${file} calls ${host} (${processor}), but ${processor} is not on /privacy.`,
  );
}

// ---------------------------------------------------------------------------
// 5. No public legal surface may claim database-enforced row isolation.
//    Turso/libSQL has no row-level security. Tenant isolation is tenant_id
//    filtering in application code, and the policy has to say so plainly.
//    Constants are checked by VALUE (what the pages render), so a comment in
//    lib/legal/constants.ts explaining this rule does not trip it.
// ---------------------------------------------------------------------------

const RLS_CLAIM = /row[\s-]*level[\s-]*security|\bRLS\b/i;
const LEGAL_PAGES = [
  "app/(marketing)/privacy/page.tsx",
  "app/(marketing)/terms/page.tsx",
  "app/(marketing)/dmca/page.tsx",
];

for (const page of LEGAL_PAGES) {
  assert.doesNotMatch(
    source(page),
    RLS_CLAIM,
    `${page} claims row-level security. The database is Turso, which has none; isolation ` +
      `is application-level tenant scoping. Describe that instead.`,
  );
}
assert.doesNotMatch(
  JSON.stringify(legal),
  RLS_CLAIM,
  "A value exported from lib/legal/constants.ts claims row-level security, and the legal " +
    "pages render those values.",
);
assert.doesNotMatch(labelText, RLS_CLAIM, `${LABEL_PATH} claims row-level security.`);

const privacySource = source("app/(marketing)/privacy/page.tsx");
assert.match(
  privacySource,
  /enforced by our application code/,
  "/privacy no longer states that tenant isolation is enforced in application code. " +
    "Removing a false claim is not enough — the security section must say what is true.",
);

// ---------------------------------------------------------------------------
// 6. Every repository document a legal surface cites must exist. The policy
//    once pointed readers at docs/compliance/LEGAL_COMPLIANCE_AUDIT.md, which
//    was never committed.
// ---------------------------------------------------------------------------

const DOC_CITATION = /\bdocs\/[A-Za-z0-9_./-]+\.(?:md|json)\b/g;
for (const rel of [...LEGAL_PAGES, "lib/legal/constants.ts", "components/legal/LegalPage.tsx"]) {
  for (const cited of source(rel).match(DOC_CITATION) ?? []) {
    assert.ok(
      existsSync(join(root, cited)),
      `${rel} cites ${cited}, which does not exist in this repository.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Quebec Law 25 (ss. 3.1-3.2): the person in charge of the protection of
//    personal information must be designated and published by title and
//    contact information.
// ---------------------------------------------------------------------------

assert.ok(
  PRIVACY_OFFICER.name.trim().split(/\s+/).length >= 2,
  "PRIVACY_OFFICER.name must be a person's full name — Law 25 requires a named person in " +
    "charge, not a role or a mailbox.",
);
assert.equal(
  PRIVACY_OFFICER.email,
  LEGAL_CONTACTS.privacy,
  "The person in charge must be reachable at the privacy contact the rest of the policy gives.",
);
assert.match(PRIVACY_OFFICER.title.en, /person in charge of the protection of personal information/i);
assert.match(PRIVACY_OFFICER.title.fr, /responsable de la protection des renseignements personnels/i);
for (const field of ["PRIVACY_OFFICER.name", "PRIVACY_OFFICER.title.en", "PRIVACY_OFFICER.email"]) {
  assert.ok(
    privacySource.includes(field),
    `/privacy does not render ${field}; Law 25 requires the person in charge to be published.`,
  );
}

// The pages render these facts from lib/legal/constants.ts; a retyped literal
// is how a page keeps saying the old thing after the constant moves (the DMCA
// agent's city was typed into /dmca until 2026-09-30).
for (const rel of [
  "app/(marketing)/privacy/page.tsx",
  "app/(marketing)/terms/page.tsx",
  "app/(marketing)/dmca/page.tsx",
  "components/legal/LegalPage.tsx",
  "app/settings/privacy/page.tsx",
]) {
  const src = readFileSync(join(root, rel), "utf8");
  for (const [name, value] of [
    ["LEGAL_PRINCIPAL_PLACE", legal.LEGAL_PRINCIPAL_PLACE],
    ["LEGAL_JURISDICTION", legal.LEGAL_JURISDICTION],
    ["PRIVACY_OFFICER.name", PRIVACY_OFFICER.name],
    ...Object.entries(LEGAL_CONTACTS).map(([k, v]) => [`LEGAL_CONTACTS.${k}`, v] as const),
  ] as const) {
    assert.ok(!src.includes(value), `${rel} types "${value}" as a literal; render ${name} from lib/legal/constants.ts.`);
  }
}

// The manifest publishes the same contact and the same person. Until
// 2026-09-30 nothing tied its three address fields to LEGAL_CONTACTS, so when
// the constants moved off the never-created privacy@ alias, the JSON would have
// kept advertising it and no test would have noticed.
assert.equal(
  label.app.privacyContact,
  LEGAL_CONTACTS.privacy,
  `${LABEL_PATH} app.privacyContact must be LEGAL_CONTACTS.privacy, the address /privacy publishes.`,
);
assert.equal(
  label.userRights.requestChannel,
  LEGAL_CONTACTS.privacy,
  `${LABEL_PATH} userRights.requestChannel must be LEGAL_CONTACTS.privacy: /privacy sends rights requests there.`,
);
assert.deepEqual(
  label.app.privacyOfficer,
  {
    name: PRIVACY_OFFICER.name,
    title: PRIVACY_OFFICER.title.en,
    titleFr: PRIVACY_OFFICER.title.fr,
    email: PRIVACY_OFFICER.email,
  },
  `${LABEL_PATH} app.privacyOfficer must match PRIVACY_OFFICER in lib/legal/constants.ts.`,
);

// ---------------------------------------------------------------------------
// 8. Model-provider sharing is disclosed per category wherever /privacy says
//    it happens. Section 3 says lead and application records go to the model
//    provider when included in agent context; those records carry contact AND
//    business fields, so both categories must name the model provider on both
//    surfaces. The business row once named only Turso and the tenant
//    (CodeRabbit on #465).
// ---------------------------------------------------------------------------

assert.match(
  privacySource,
  /Lead and application records when they are included in the context of\s+an agent task/,
  "/privacy no longer says lead and application records reach model providers. If that " +
    "changed, update this section deliberately rather than letting it pass.",
);
const LEAD_RECORD_CATEGORIES: { matrix: string; label: string }[] = [
  { matrix: "Contact identifiers", label: "Contact Info" },
  { matrix: "Business identifiers", label: "Business & Financial Info" },
];
for (const c of LEAD_RECORD_CATEGORIES) {
  const row = DATA_MATRIX.find((d) => d.category === c.matrix);
  assert.ok(row, `DATA_MATRIX has no "${c.matrix}" row.`);
  assert.match(
    row.sharedWith,
    /model provider/i,
    `DATA_MATRIX "${c.matrix}" omits the model provider, but /privacy section 3 says lead and ` +
      `application records are sent to it when included in agent context.`,
  );
  const cat = label.dataCollected.find((d) => d.category === c.label);
  assert.ok(cat, `${LABEL_PATH} has no "${c.label}" category.`);
  assert.ok(
    (cat.sharedWith ?? []).some((w) => /model provider/i.test(w)),
    `${LABEL_PATH} "${c.label}" omits the model provider that /privacy section 3 discloses.`,
  );
}

// ---------------------------------------------------------------------------
// 9. Law 25 s.17: the transfer section must not claim an assessment that does
//    not exist. It once implied the processors not marked "Under review" had
//    been assessed; none has. While the assessment is open, the page says so
//    and the manifest carries it as an open gap.
// ---------------------------------------------------------------------------

{
  const start = privacySource.indexOf('title="International transfers"');
  assert.ok(start >= 0, "/privacy has no International transfers section.");
  const end = privacySource.indexOf("<LegalSection", start);
  // JSX wraps prose across lines; collapse whitespace so a phrase split by a
  // line break still matches.
  const transfers = privacySource.slice(start, end > start ? end : undefined).replace(/\s+/g, " ");
  assert.match(transfers, /privacy impact assessment/, "The transfers section must name the Law 25 s.17 assessment.");
  assert.doesNotMatch(
    transfers,
    /assessments? (?:is|are|was|were|has been|have been) (?:complete|completed|done)|we have (?:completed|conducted|carried out) (?:the|an|that|our) assessment/i,
    "The transfers section claims a completed Law 25 transfer assessment. Say that only once one exists.",
  );
  if (/in progress/.test(transfers)) {
    assert.ok(
      (label.openGaps ?? []).some((g) => /s\.17/.test(g) && /not yet completed/.test(g)),
      `/privacy says the transfer assessments are in progress, so ${LABEL_PATH} openGaps must list them.`,
    );
  }
}

console.log("legal-compliance-drift: ok");
