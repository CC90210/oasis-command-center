import assert from "node:assert/strict";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import { isFieldVisible } from "../lib/forms/visibility";
import {
  OASIS_FUNNEL_SLUG,
  OASIS_FUNNEL_STEPS,
  OASIS_FUNNEL_BRANDING,
  OASIS_FUNNEL_ON_COMPLETE_STAGE,
  buildOasisFunnelRow,
} from "../lib/forms/oasis-funnel-seed";
import { buildOasisFunnelAlert, buildOasisLeadPatch } from "../lib/forms/oasis-funnel-format";

// ---------------------------------------------------------------------------
// Definition validity — the seed must parse through the canonical validators.
// ---------------------------------------------------------------------------
const steps = parseFormSteps(OASIS_FUNNEL_STEPS);
parseFormBranding(OASIS_FUNNEL_BRANDING);
assert.equal(steps.length, 3, "funnel has 3 steps");
assert.equal(steps[0].key, "interest");
assert.equal(steps[1].key, "details");
assert.equal(steps[2].key, "contact");

const row = buildOasisFunnelRow();
assert.equal(row.slug, OASIS_FUNNEL_SLUG, "row slug = OASIS_FUNNEL_SLUG");
assert.equal(row.on_complete_stage, OASIS_FUNNEL_ON_COMPLETE_STAGE, "row stage = new_contact");
assert.equal(row.on_complete_stage, "new_contact", "stage is a valid OASIS lead stage");
assert.equal(row.enabled, true, "form enabled");

// ---------------------------------------------------------------------------
// Branching — picking ONE interest reveals only that branch on step 1.
// ---------------------------------------------------------------------------
const detailFields = steps[1].fields;
function visibleNames(answers: Record<string, unknown>): string[] {
  return detailFields.filter((f) => isFieldVisible(f, answers)).map((f) => f.name);
}

assert.deepEqual(
  visibleNames({ interests: ["ai"] }),
  ["business_name", "business_type", "biggest_pain"],
  "AI-only → AI fields only",
);
assert.deepEqual(
  visibleNames({ interests: ["music"] }),
  ["event_type", "event_date", "music_vibe"],
  "Music-only → Music fields only",
);
assert.deepEqual(
  visibleNames({ interests: ["brand"] }),
  ["brand_goal", "audience", "current_following"],
  "Brand-only → Brand fields only",
);
assert.equal(visibleNames({ interests: [] }).length, 0, "no interest → no branch fields");
assert.equal(
  visibleNames({ interests: ["ai", "brand"] }).length,
  6,
  "AI+Brand → both branches (6 fields)",
);

// The required-field skip that prevents an AI-only lead being blocked by the
// Music branch: event_type IS required, but hidden for an AI-only lead.
const eventType = detailFields.find((f) => f.name === "event_type")!;
assert.equal(eventType.required, true, "event_type is required (within its branch)");
assert.equal(
  isFieldVisible(eventType, { interests: ["ai"] }),
  false,
  "event_type hidden for AI-only → server skips its required check",
);

// ---------------------------------------------------------------------------
// Telegram alert — content + HTML escaping of user input.
// ---------------------------------------------------------------------------
const alert = buildOasisFunnelAlert({
  name: "Jane <script>",
  email: "jane@example.com",
  phone: "555",
  instagram: "@janed",
  interests: ["ai"],
  business_name: "Acme & Co <b>",
  business_type: "service",
  biggest_pain: ["lead-followup"],
});
assert.ok(alert.includes("New Funnel Lead"), "alert has header");
assert.ok(alert.includes("jane@example.com"), "alert has email");
assert.ok(alert.includes("@janed"), "alert has IG (stripped @)");
assert.ok(alert.includes("⚡ AI Audit"), "alert maps interest label");
assert.ok(alert.includes("Acme &amp; Co &lt;b&gt;"), "alert HTML-escapes business name");
assert.ok(alert.includes("Jane &lt;script&gt;"), "alert HTML-escapes lead name");
assert.ok(!alert.includes("<script>"), "no raw user angle-brackets leak into HTML message");

// ---------------------------------------------------------------------------
// buildOasisLeadPatch — maps funnel answers → canonical OASIS lead fields the
// pipeline reads (data.name/company/email/phone/notes). Without this the lead
// renders blank (contact is collected last + stored as contact_name).
// ---------------------------------------------------------------------------
const patch = buildOasisLeadPatch({
  name: "Jane Doe",
  email: "JANE@Example.com",
  phone: "555-1212",
  instagram: "@janed",
  interests: ["ai", "brand"],
  business_name: "Acme Co",
  business_type: "service",
  biggest_pain: ["lead-followup", "scheduling"],
  brand_goal: "grow",
  audience: ["entrepreneurs"],
  current_following: "2k-10k",
});
assert.equal(patch.name, "Jane Doe", "patch.name set (pipeline reads data.name)");
assert.equal(patch.email, "jane@example.com", "patch.email lowercased");
assert.equal(patch.phone, "555-1212", "patch.phone set");
assert.equal(patch.company, "Acme Co", "patch.company from business_name");
assert.equal(patch.instagram, "janed", "patch.instagram stripped @");
assert.ok(typeof patch.notes === "string" && (patch.notes as string).includes("AI & Automation"));
assert.ok((patch.notes as string).includes("Personal Brand"), "notes summarize both interests");

// Falls back to contact_name when name absent; empty when nothing usable.
assert.equal(buildOasisLeadPatch({ contact_name: "Bob" }).name, "Bob", "contact_name fallback");
assert.deepEqual(buildOasisLeadPatch({}), {}, "no usable fields → empty patch");

console.log("oasis-funnel ok");
