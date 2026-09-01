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
assert.ok(battleCard.includes('id="industry-automations"'), "the battle card exposes industry opportunities during a call");
assert.ok(battleCard.includes("initialIndustry={lead.industry}"), "the battle card preselects the lead's industry");
assert.ok(
  battleCard.includes('defaultOpen={true}'),
  "the automation guide is open by default so a rep does not hunt for it mid-call",
);

const guide = read("components/playbook/IndustryAutomationGuide.tsx");
assert.ok(guide.includes("CC or Adon confirms feasibility"), "custom ideas are discovery paths, never rep promises");
assert.doesNotMatch(guide, /dangerouslySetInnerHTML/, "catalog copy is rendered as text");

console.log("industry-automations ok");
