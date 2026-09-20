/**
 * No public surface may wear, page, or hand a visitor to another tenant.
 *
 * Six leaks were found on 2026-09-18 and every one was the same shape: a
 * module-level constant standing in for a tenant decision. The constant was
 * always SunBiz's, because SunBiz was the only tenant when each was written.
 * The asymmetry is what hid them — SunBiz's forms set explicit branding, so
 * SunBiz never reached any of these defaults. They were visible only to the
 * companies they did not belong to.
 *
 * These assertions are about the RULE, not about today's values. A future
 * tenant must be covered by construction, so several tests iterate the registry
 * rather than naming brands.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  publicIdentityForTenant,
  publicMarkForTenant,
  companyForTenant,
  notifyLanesForTenant,
  safeLandingForTenant,
  faviconForTenant,
} from "@/lib/tenant/public-identity";
import { TENANT_ID_BRAND, TENANT_SLUG_BRAND } from "@/lib/email/brand-for-tenant";
import { DEFAULT_PRIMARY_COLOR, DEFAULT_ACCENT_COLOR } from "@/lib/forms/themes";
import { FORM_CHECKS } from "@/lib/health/form-checks";

const OASIS_TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ_TENANT = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

// ── the registry resolves, and fails closed ────────────────────────────────

assert.equal(companyForTenant({ tenantId: OASIS_TENANT }), "oasis");
assert.equal(companyForTenant({ tenantId: SUNBIZ_TENANT }), "sunbiz");
assert.equal(companyForTenant({ tenantSlug: "oasis-ai-cc" }), "oasis");
assert.equal(companyForTenant({ tenantSlug: "submissions" }), "sunbiz");
assert.equal(companyForTenant({ tenantSlug: "sun" }), "sunbiz");

// An unmapped tenant resolves to NOTHING. Every function must say "I don't
// know" rather than pick a company — that substitution IS the defect.
const UNKNOWN = { tenantSlug: "some-new-client" };
assert.equal(publicIdentityForTenant(UNKNOWN), null, "unmapped tenant got an identity");
assert.equal(publicMarkForTenant(UNKNOWN), null, "unmapped tenant got a logo");
assert.equal(companyForTenant(UNKNOWN), null);
assert.equal(safeLandingForTenant(UNKNOWN), null, "unmapped tenant got a landing page");
assert.equal(faviconForTenant(UNKNOWN), null, "unmapped tenant got a favicon");

// The near-miss slug is a DIFFERENT company that merely shares a prefix.
assert.equal(
  companyForTenant({ tenantSlug: "submissions-5f63d7e6" }),
  null,
  "a prefix match was treated as SunBiz — exact match only",
);

// ── no tenant may be handed another tenant's identity ──────────────────────

const oasisMark = publicMarkForTenant({ tenantId: OASIS_TENANT });
const sunbizMark = publicMarkForTenant({ tenantId: SUNBIZ_TENANT });
assert.ok(oasisMark, "OASIS has no mark to resolve");
assert.ok(sunbizMark, "SunBiz has no mark to resolve");
assert.notEqual(oasisMark, sunbizMark, "both tenants resolve to the SAME mark");
assert.match(String(oasisMark), /oasis/i, "OASIS's mark is not an OASIS asset");
assert.doesNotMatch(String(oasisMark), /sunbiz/i, "OASIS resolves to a SunBiz asset");
assert.doesNotMatch(String(sunbizMark), /oasis/i, "SunBiz resolves to an OASIS asset");

assert.notEqual(
  faviconForTenant({ tenantId: OASIS_TENANT }),
  faviconForTenant({ tenantId: SUNBIZ_TENANT }),
  "both tenants share one favicon — a merchant sees the other company's tab icon",
);

// ── incidents page the lane that owns them ─────────────────────────────────

assert.deepEqual(notifyLanesForTenant({ tenantSlug: "oasis-ai-cc" }), ["operator"]);
assert.deepEqual(notifyLanesForTenant({ tenantSlug: "submissions" }), ["sunbiz-ops"]);

// Unknown fans to BOTH rather than defaulting to one. A lost submission nobody
// is paged about is worse than one two teams see; two production dead-letter
// rows carry tenant_slug NULL, so this path is real, not theoretical.
const unknownLanes = notifyLanesForTenant(UNKNOWN);
assert.equal(unknownLanes.length, 2, "an unknown tenant defaulted to a single lane");
assert.ok(unknownLanes.includes("operator") && unknownLanes.includes("sunbiz-ops"));

// ── an untrusted click lands on ITS OWN tenant's page ──────────────────────

assert.equal(
  safeLandingForTenant({ tenantId: SUNBIZ_TENANT }),
  "/f/submissions/initial-lead-capture",
  "SunBiz's landing changed — the 13 live redirects in production would move",
);
assert.equal(safeLandingForTenant({ tenantId: OASIS_TENANT }), "/f/oasis-ai-cc/ai-audit");
assert.notEqual(
  safeLandingForTenant({ tenantId: OASIS_TENANT }),
  safeLandingForTenant({ tenantId: SUNBIZ_TENANT }),
  "an OASIS click still lands on SunBiz's intake form",
);

// ── no shared default may be a live company's brand ────────────────────────

// The unbranded-form palette must belong to NOBODY. It was #E0A53F — SunBiz
// Standard gold — so every unbranded form on the platform rendered in a client's
// brand colour.
for (const [label, value] of [
  ["DEFAULT_PRIMARY_COLOR", DEFAULT_PRIMARY_COLOR],
  ["DEFAULT_ACCENT_COLOR", DEFAULT_ACCENT_COLOR],
] as const) {
  for (const brandHex of ["#E0A53F", "#FFB81C", "#D4A843", "#175637", "#00d4ff", "#00D4FF"]) {
    assert.notEqual(
      value.toLowerCase(),
      brandHex.toLowerCase(),
      `${label} is ${brandHex} — a live brand colour cannot be the shared default`,
    );
  }
}

// ── the removed glyph must not come back ───────────────────────────────────

const formClient = readFileSync("components/forms/FormPublicClient.tsx", "utf8");
assert.doesNotMatch(
  formClient,
  /function SunMark/,
  "SunMark is back — one company's glyph cannot be the multi-tenant default",
);
assert.doesNotMatch(
  formClient,
  /<SunMark/,
  "the form header renders SunMark again",
);

// The click route must not reacquire a hardcoded cross-tenant landing.
const clickRoute = readFileSync("app/api/track/click/[id]/route.ts", "utf8");
assert.doesNotMatch(
  clickRoute,
  /const SAFE_DEFAULT\s*=\s*`?\$\{APP_BASE\}\/f\/submissions/,
  "SAFE_DEFAULT points at SunBiz's intake again — every tenant's bad click lands there",
);

// The failure alert must not reacquire a hardcoded lane.
const failCapture = readFileSync("lib/forms/submit-failure-capture.ts", "utf8");
assert.doesNotMatch(
  failCapture,
  /sendTelegram\([^)]*lane:\s*"sunbiz-ops"/s,
  "the blocked-submission alert hardcodes sunbiz-ops again",
);

// ── every mapped tenant is fully served ────────────────────────────────────

// Iterating the registry means a tenant added tomorrow is covered by this test
// the day it is added, rather than the day someone remembers to extend it.
for (const slug of Object.keys(TENANT_SLUG_BRAND)) {
  const id = publicIdentityForTenant({ tenantSlug: slug });
  assert.ok(id, `mapped slug ${slug} resolved to no identity`);
  assert.ok(id.displayName, `${slug} has no display name`);
  assert.ok(id.accent, `${slug} has no accent colour`);
  assert.ok(notifyLanesForTenant({ tenantSlug: slug }).length === 1, `${slug} is ambiguous`);
  // A landing page is required of every brand that HAS a public funnel, and
  // Bluerise does not — it is an email brand. The rule being pinned is not
  // "everyone gets a door" but "nobody gets SOMEBODY ELSE'S door": a brand with
  // no funnel resolves to null and the caller sends the visitor to the neutral
  // page. Asserting a landing for every slug is what would push bluerise back
  // onto SunBiz Funding's intake form.
  const landing = safeLandingForTenant({ tenantSlug: slug });
  if (id.brand === "bluerise") {
    assert.equal(landing, null, `${slug} is a Bluerise tenant and was given a funnel that is not its own`);
  } else {
    assert.ok(landing, `${slug} has no landing page`);
  }
}
for (const tid of Object.keys(TENANT_ID_BRAND)) {
  assert.ok(publicIdentityForTenant({ tenantId: tid }), `mapped tenant ${tid} resolved to nothing`);
}


// ── an estate-wide health check may not page one company ───────────────────

// forms.submit_failures_open watches the dead-letter table and DELIBERATELY
// ignores tenantId ("a blocked application is a blocked application"). With no
// lane declared it fell to the runner default — SunBiz's — so an OASIS
// merchant's blocked submission re-asserted into the client's channel every 15
// minutes. The instant page resolves its lane from the tenant; this re-assertion
// has no tenant to resolve, so it must tell everyone.
const openCheck = FORM_CHECKS.find((c) => c.id === "forms.submit_failures_open");
assert.ok(openCheck, "forms.submit_failures_open is gone");
assert.ok(
  Array.isArray(openCheck.lane) &&
    openCheck.lane.includes("operator") &&
    openCheck.lane.includes("sunbiz-ops"),
  "the estate-wide blocked-submission check pages only one company again",
);


// ── BOTH funnel routes resolve identity, not just one ──────────────────────

// The anonymous route is what an operator pastes into Slack. The [lead_token]
// route is the personalised link Solara mints and texts a merchant, and it is
// where the full application and the bank-statement upload live. Fixing one and
// not the other leaves the wrong mark on the more sensitive page — which is
// exactly what happened on the first pass of this change.
for (const route of [
  "app/f/[tenant_slug]/[form_slug]/page.tsx",
  "app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx",
]) {
  const src = readFileSync(route, "utf8");
  assert.match(src, /publicMarkForTenant\(/, route + " does not resolve the tenant logo");
  assert.match(src, /faviconForTenant\(/, route + " does not resolve the tenant favicon");
  assert.match(src, /icons: \{ icon \}/, route + " resolves a favicon but never emits it");
}

// ── the per-tenant icon must actually be able to win ───────────────────────

// A FILE-BASED ICON IS NOT OVERRIDABLE. Next discovers app/favicon.ico and
// unshifts it ahead of whatever a route's generateMetadata returns, so the
// per-tenant icon loses: production emitted OASIS's favicon first, with the
// more specific sizes/type, then SunBiz's, and the browser took the first.
// Every assertion above passed the whole time. Declared as layout config it is
// a DEFAULT a route can replace; the file moves to public/, same URL.
assert.ok(
  !existsSync("app/favicon.ico"),
  "app/favicon.ico is back — a file-based icon outranks every per-tenant icon and silently reverts all of the above",
);
assert.ok(existsSync("public/favicon.ico"), "public/favicon.ico is missing — /favicon.ico now 404s estate-wide");
assert.match(
  readFileSync("app/layout.tsx", "utf8"),
  /icons: \{ icon: "\/favicon\.ico" \}/,
  "the default icon is no longer declared in the root layout — pages with no tenant lost their favicon",
);

// ── brand, not company ─────────────────────────────────────────────────────

// BRAND_COMPANY maps bluerise -> sunbiz, which is right for "whose ops lane
// owns this incident" and wrong for "whose front door is this". Branching on
// company put a Bluerise prospect in SunBiz Funding's tab and on SunBiz
// Funding's intake form: the same hand-off to another company this module
// exists to prevent, one level up the map.
{
  const bluerise = Object.entries(TENANT_ID_BRAND)
    .filter(([, brand]) => brand === "bluerise")
    .map(([tenantId]) => tenantId);
  for (const tenantId of bluerise) {
    assert.equal(
      faviconForTenant({ tenantId }),
      null,
      "a Bluerise tenant wears SunBiz Funding's mark in the browser tab",
    );
    assert.equal(
      safeLandingForTenant({ tenantId }),
      null,
      "a Bluerise prospect is handed to SunBiz Funding's intake form",
    );
  }
}
const IDENTITY_SRC = readFileSync("lib/tenant/public-identity.ts", "utf8");
for (const fn of ["safeLandingForTenant", "faviconForTenant"]) {
  const body = IDENTITY_SRC.split(`export function ${fn}`)[1]?.split("\n}")[0] ?? "";
  assert.doesNotMatch(
    body,
    /companyForTenant\(/,
    `${fn} branches on company again — bluerise collapses into sunbiz and wears its identity`,
  );
}

// ── the neutral landing belongs to nobody ──────────────────────────────────

// The first fix pointed this at APP_BASE. oasisai.work IS OASIS AI's marketing
// site, so a SunBiz merchant with a dead link landed on another company's
// pitch — the same leak, pointing the other way.
const CLICK_SRC = readFileSync("app/api/track/click/[id]/route.ts", "utf8");
assert.match(
  CLICK_SRC,
  /const NEUTRAL_LANDING = `\$\{APP_BASE\}\/link-expired`/,
  "the unresolvable click lands on a company's own site again",
);
assert.ok(
  existsSync("app/link-expired/page.tsx"),
  "the neutral landing page does not exist — every unresolvable click 404s",
);
// Only what RENDERS. The file's own comment explains which company's site the
// old target belonged to, and that explanation is the reason the page exists.
const EXPIRED_SRC = readFileSync("app/link-expired/page.tsx", "utf8");
const EXPIRED_RENDERED = EXPIRED_SRC.slice(EXPIRED_SRC.indexOf("return ("));
for (const forbidden of ["OASIS", "SunBiz", "Blue Rise", "oasis-logo", "sunbiz-logo", "<img"]) {
  assert.ok(
    !EXPIRED_RENDERED.includes(forbidden),
    `the neutral landing page renders ${forbidden} — it belongs to neither company`,
  );
}

console.log("tenant-public-identity: all assertions passed");
