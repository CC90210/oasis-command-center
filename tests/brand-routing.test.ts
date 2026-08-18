/**
 * tests/brand-routing.test.ts — which brand speaks to a merchant, and when it
 * hands off.
 *
 * THE RULE (Adon, 2026-08-05): whichever company the merchant already knows goes
 * first; the other company is the follow-up act. A lead that came through the
 * SunBiz funnel hears from SunBiz, then Bluerise if it goes quiet. A cold sourced
 * lead that knows nobody hears from Bluerise, then SunBiz.
 *
 * The two guards below are legal controls, not preferences, and they are the
 * reason this file exists as a pure unit test rather than being folded into the
 * executor: they decide whether a real person keeps receiving mail.
 */

import assert from "node:assert/strict";
import {
  resolveInitialBrand,
  shouldSwitchBrand,
  otherBrand,
  classifyLeadSource,
} from "../lib/drips/brand-routing";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-05T12:00:00Z");
const LAUNCH = Date.parse("2026-08-05T00:00:00Z");

// ---------------------------------------------------------------------------
// Source classification, against the sources that ACTUALLY exist in production
// (measured 2026-08-05 across 1,194 leads).
// ---------------------------------------------------------------------------
assert.equal(classifyLeadSource("public_form"), "warm", "560 leads: inbound to a SunBiz form");
assert.equal(classifyLeadSource("dropped_application"), "warm", "16 leads: they started an application");
assert.equal(classifyLeadSource("cold_call_tracker"), "cold", "119 leads");
assert.equal(classifyLeadSource("breeze_uw_sheet"), "cold", "83 leads: live-sub sourced");
// NOT cold. The name reads like a vendor drop and it sat in BUILTIN_COLD until
// 2026-08-18, which was our labelling error: it is a SunBiz web form and the
// merchant filled it in. Adon: "none of our leads are purchased. We generate
// our own leads." Consequence of the mistake was not cosmetic — the same string
// sat outside INQUIRY_SOURCES, so 239 phone-only merchants who completed a
// SunBiz form could not be texted at all.
assert.equal(classifyLeadSource("MCA WEBFORMS MAY 25-29"), "warm", "407 leads: our own web form");

// Case and whitespace must not change the answer; these strings are hand-entered.
assert.equal(classifyLeadSource("  COLD_CALL_TRACKER  "), "cold");
assert.equal(classifyLeadSource("Public_Form"), "warm");

// An unrecognised source is UNKNOWN, not silently cold. The caller decides, and
// the safe direction is the established brand.
assert.equal(classifyLeadSource("some_new_list_2027"), "unknown");
assert.equal(classifyLeadSource(""), "unknown");
assert.equal(classifyLeadSource(undefined), "unknown");
assert.equal(classifyLeadSource(null), "unknown");

// ---------------------------------------------------------------------------
// Initial assignment
// ---------------------------------------------------------------------------

// EVERY lead already in the CRM predates Bluerise and knows SunBiz. This is the
// single most important case: all 1,194 existing leads must land on SunBiz
// regardless of how cold their source looks, because they have already had
// SunBiz contact and a sudden new company name would be the confusing outcome.
assert.equal(
  resolveInitialBrand({ createdAtMs: Date.parse("2026-07-01T00:00:00Z"), source: "cold_call_tracker", blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
  "a pre-launch lead is SunBiz even when its source is cold",
);
assert.equal(
  resolveInitialBrand({ createdAtMs: Date.parse("2026-05-20T00:00:00Z"), source: "MCA WEBFORMS MAY 25-29", blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
);

// A brand-new COLD sourced lead knows nobody, so Bluerise carries it.
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: "cold_call_tracker", blueriseLaunchAtMs: LAUNCH }),
  "bluerise",
);
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: "breeze_uw_sheet", blueriseLaunchAtMs: LAUNCH }),
  "bluerise",
);

// A new INBOUND lead came to a SunBiz surface, so it stays SunBiz.
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: "public_form", blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
);

// Unknown source on a NEW lead falls back to SunBiz. Never guess a merchant onto
// the brand-new domain: a cold lead mis-sent as SunBiz costs reputation on a
// domain that can absorb it, while a warm merchant mis-sent as Bluerise is a
// confusing first impression AND burns the domain that cannot.
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: "some_new_list_2027", blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
);
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: undefined, blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
);

// A missing or unparseable creation time is treated as PRE-launch, for the same
// reason: reading absence as "just arrived" would push the back catalogue onto
// the domain with no reputation.
assert.equal(resolveInitialBrand({ createdAtMs: NaN, source: "cold_call_tracker", blueriseLaunchAtMs: LAUNCH }), "sunbiz");
assert.equal(resolveInitialBrand({ createdAtMs: undefined, source: "cold_call_tracker", blueriseLaunchAtMs: LAUNCH }), "sunbiz");

// An already-stamped brand is STICKY and wins over every heuristic. Re-deriving
// on every dispatch run would let a lead flip brand mid-sequence.
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: "cold_call_tracker", existingBrand: "sunbiz", blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
);
assert.equal(
  resolveInitialBrand({ createdAtMs: Date.parse("2026-01-01T00:00:00Z"), source: "public_form", existingBrand: "bluerise", blueriseLaunchAtMs: LAUNCH }),
  "bluerise",
);
// A garbage stamped value is ignored rather than trusted.
assert.equal(
  resolveInitialBrand({ createdAtMs: NOW, source: "public_form", existingBrand: "nonsense", blueriseLaunchAtMs: LAUNCH }),
  "sunbiz",
);

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------
assert.equal(otherBrand("sunbiz"), "bluerise");
assert.equal(otherBrand("bluerise"), "sunbiz");

const base = {
  currentBrand: "sunbiz" as const,
  brandAssignedAtMs: NOW - 30 * DAY,
  lastInboundAtMs: null as number | null,
  switchCount: 0,
  suppressed: false,
  optedOut: false,
  nowMs: NOW,
  silenceDays: 21,
};

// Silent for 30 days, never switched: hand off.
assert.deepEqual(shouldSwitchBrand(base), { switch: true, to: "bluerise" });

// Not silent long enough yet.
assert.equal(shouldSwitchBrand({ ...base, brandAssignedAtMs: NOW - 5 * DAY }).switch, false);
// Exactly at the boundary counts as silent (>=, not >).
assert.equal(shouldSwitchBrand({ ...base, brandAssignedAtMs: NOW - 21 * DAY }).switch, true);

// They REPLIED after assignment. A responding merchant is warm, and handing a
// live conversation to a different company is the worst version of this feature.
assert.equal(shouldSwitchBrand({ ...base, lastInboundAtMs: NOW - 2 * DAY }).switch, false);
// A reply long ago does not protect forever: silence restarts from the reply.
assert.deepEqual(
  shouldSwitchBrand({ ...base, lastInboundAtMs: NOW - 40 * DAY }),
  { switch: true, to: "bluerise" },
);

// ONE switch per lead, ever. Alternating brands at a single merchant is exactly
// the behaviour that generates spam complaints, which is what the whole split
// exists to avoid.
assert.equal(shouldSwitchBrand({ ...base, switchCount: 1 }).switch, false);
assert.equal(shouldSwitchBrand({ ...base, switchCount: 5 }).switch, false);

// NEVER switch a lead that opted out or is suppressed. Ignoring you is fair game
// for the other brand; asking you to stop is final for BOTH. This is the legal
// control, and it must hold even when every other condition says switch.
assert.equal(shouldSwitchBrand({ ...base, optedOut: true }).switch, false);
assert.equal(shouldSwitchBrand({ ...base, suppressed: true }).switch, false);
assert.equal(
  shouldSwitchBrand({ ...base, optedOut: true, suppressed: true, brandAssignedAtMs: NOW - 999 * DAY }).switch,
  false,
  "no amount of silence unlocks a switch for someone who opted out",
);

// The reason is reported so a dispatch log can explain itself.
assert.equal((shouldSwitchBrand({ ...base, optedOut: true }) as { reason: string }).reason, "opted_out");
assert.equal((shouldSwitchBrand({ ...base, suppressed: true }) as { reason: string }).reason, "suppressed");
assert.equal((shouldSwitchBrand({ ...base, switchCount: 1 }) as { reason: string }).reason, "already_switched");

// Reverse direction works identically: a cold lead that ignored Bluerise moves
// to SunBiz.
assert.deepEqual(shouldSwitchBrand({ ...base, currentBrand: "bluerise" }), { switch: true, to: "sunbiz" });

// A nonsense silenceDays cannot disable the window.
assert.equal(shouldSwitchBrand({ ...base, silenceDays: 0, brandAssignedAtMs: NOW - 1000 }).switch, false);
assert.equal(shouldSwitchBrand({ ...base, silenceDays: -5, brandAssignedAtMs: NOW - 1000 }).switch, false);

console.log("brand-routing.test.ts — all assertions passed ✓");
