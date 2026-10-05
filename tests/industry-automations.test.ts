import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INDUSTRY_AUTOMATIONS,
  matchIndustryAutomationGroup,
} from "../lib/industry-automations";

const read = (path: string) => readFileSync(path, "utf8");

assert.equal(INDUSTRY_AUTOMATIONS.length, 9, "the call guide covers nine major industry groups");
assert.ok(
  INDUSTRY_AUTOMATIONS.every((group) => group.automations.length >= 8),
  "every industry has a useful call-side menu, not a token example",
);
assert.equal(matchIndustryAutomationGroup("Restaurants & Bars").id, "restaurants-bars");
assert.equal(matchIndustryAutomationGroup("HVAC / Heating & Cooling").id, "home-services");
assert.equal(matchIndustryAutomationGroup("Dental clinic").id, "health-wellness");
assert.equal(matchIndustryAutomationGroup("Unknown vertical").id, "restaurants-bars", "unknown free text falls back safely");

for (const group of INDUSTRY_AUTOMATIONS) {
  const names = new Set<string>();
  for (const offering of group.automations) {
    assert.ok(offering.name && offering.outcome && offering.discovery && offering.buildType, `${group.id} offerings are complete`);
    assert.equal(names.has(offering.name), false, `${group.id} must not repeat ${offering.name}`);
    names.add(offering.name);
  }
}

const index = read("app/playbook/page.tsx");
assert.ok(index.includes('href: "/playbook/automations"'), "the playbook links the industry catalog");
assert.equal(
  (index.match(/href: "\/playbook\/deals"/g) || []).length,
  1,
  "Website Offer and Pipeline Operating Guide must not remain duplicate cards",
);
assert.ok(read("app/playbook/automations/page.tsx").includes("<IndustryAutomationGuide"), "the playbook renders the shared guide");

const battleCard = read("components/web-leads/BattleCard.tsx");
// Re-aimed with the compact card (Adon, 2026-10-01). The guide was its own open
// section, a second sell-list one block below the lead's ranked catalogue. It
// now folds UNDER that catalogue, inside the open "What we would build for
// them" section, on every lead that has one, and stands on its own for a lead
// whose score is hidden. What is still required: a rep on a call can reach it
// without leaving the card, preselected to the lead's industry, and the build
// section it lives in is open by default.
assert.ok(battleCard.includes("<IndustryIdeas industry={industry} />"), "the battle card exposes industry opportunities under the build list");
assert.ok(battleCard.includes("industry={lead.industry}"), "both build mounts pass the lead's industry through");
assert.ok(battleCard.includes("initialIndustry={industry}"), "the battle card preselects the lead's industry");
assert.ok(battleCard.includes("initialIndustry={lead.industry}"), "a lead with a hidden score still gets the industry list");
assert.ok(
  /<BattleSection\s+id="fixes"\s+defaultOpen=\{true\}/.test(battleCard) && battleCard.includes('<BattleSection id="build" defaultOpen={true}'),
  "the build section the guide lives in is open by default so a rep does not hunt for it mid-call",
);

const guide = read("components/playbook/IndustryAutomationGuide.tsx");
assert.ok(guide.includes("CC or Adon confirms feasibility"), "custom ideas are discovery paths, never rep promises");
assert.doesNotMatch(guide, /dangerouslySetInnerHTML/, "catalog copy is rendered as text");

console.log("industry-automations ok");
