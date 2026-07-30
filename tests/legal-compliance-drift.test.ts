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
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBPROCESSORS, DATA_MATRIX } from "@/lib/legal/constants";

const root = join(__dirname, "..");

const label = JSON.parse(
  readFileSync(join(root, "docs/compliance/PRIVACY_NUTRITION_LABEL.json"), "utf8"),
) as {
  tracking: { thirdPartyAnalyticsSdks: unknown[]; advertisingPixels: unknown[] };
  subprocessors: { name: string; dpaInPlace: boolean }[];
  dataCollected: { category: string; sensitive: boolean }[];
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
    `app/privacy/page.tsx section 4 still tells users this app loads no third-party ` +
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

console.log("legal-compliance-drift: ok");
