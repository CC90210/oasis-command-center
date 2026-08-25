import assert from "node:assert/strict";
import {
  buildBriefForOnboarding,
  normalizeWebsiteBuildBrief,
  websiteBuildBriefIsReady,
} from "../lib/website-sales-build-brief";

const input = {
  businessGoal: "Turn local search traffic into booked estimates.",
  targetAudience: "Homeowners in Montreal needing emergency repairs.",
  mustHavePages: "Home, services, service areas, about, contact.",
  requiredFeatures: "Quote request, click-to-call, reviews, analytics.",
  integrations: "Google Business Profile and GA4.",
  contentAndAssets: "Logo exists; OASIS will draft the page copy.",
  domainAndAccess: "Client owns the domain and will provide delegated access.",
  launchTiming: "Target launch in four weeks.",
  decisionProcess: "Owner approves scope and final launch.",
  transcriptNotes: "Customer emphasized mobile calls and weekend availability.",
};

const normalized = normalizeWebsiteBuildBrief(input, "user-1", "2026-08-24T10:00:00.000Z");
assert.equal(normalized.ok, true);
if (!normalized.ok) throw new Error(normalized.error);
assert.equal(websiteBuildBriefIsReady(normalized.brief), true);
assert.equal(buildBriefForOnboarding(normalized.brief).status, "ready_for_builder");

const incomplete = normalizeWebsiteBuildBrief({ ...input, requiredFeatures: "" }, "user-1");
assert.deepEqual(incomplete, { ok: false, error: "build_brief_requiredFeatures_required" });
assert.equal(websiteBuildBriefIsReady({ ...normalized.brief, status: "draft" }), false);

console.log("website-sales-build-brief: OK");
