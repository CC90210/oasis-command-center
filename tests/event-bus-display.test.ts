/**
 * Smoke tests for lib/event-bus-display.ts. The /agents page reads
 * raw SCREAMING_SNAKE_CASE event types from Postgres and renders them
 * through these formatters — a regression here lands instantly in the
 * operator's face.
 *
 * Run: npm run test:event-bus
 */
import assert from "node:assert/strict";
import { formatEventType, formatPublisher } from "@/lib/event-bus-display";

let passed = 0;
let failed = 0;
const test = (label: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok    ${label}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${label}\n         ${msg}`);
  }
};

console.log("=== formatEventType ===");

test("strips BRAVO_ prefix and lowercases the rest", () => {
  assert.equal(formatEventType("BRAVO_EMAIL_OPENED"), "Email opened");
});

test("handles multi-word event types", () => {
  assert.equal(formatEventType("BRAVO_LEAD_AUTO_BUMPED"), "Lead auto bumped");
  assert.equal(formatEventType("BRAVO_RECORD_STATUS_CHANGED"), "Record status changed");
});

test("strips MAVEN_/ATLAS_/HERMES_ prefixes too", () => {
  assert.equal(formatEventType("MAVEN_POST_SCHEDULED"), "Post scheduled");
  assert.equal(formatEventType("ATLAS_TAX_FILED"), "Tax filed");
  assert.equal(formatEventType("HERMES_SLEEP_LOGGED"), "Sleep logged");
});

test("treats dots as word separators (legacy event names)", () => {
  assert.equal(formatEventType("OUTBOUND.RECORDED"), "Outbound recorded");
  assert.equal(formatEventType("inbound.classified"), "Inbound classified");
});

test("empty / null / non-string falls through safely", () => {
  assert.equal(formatEventType(""), "");
  assert.equal(formatEventType(null as unknown as string), "");
  assert.equal(formatEventType(undefined as unknown as string), "");
});

test("event with no prefix still pretty-prints", () => {
  assert.equal(formatEventType("USER_CLICKED_THING"), "Clicked thing");
  // Single bare word — no underscore to strip, so the prefix regex
  // is a no-op and the lowercase+capitalize still applies. "BOOT" → "Boot".
  assert.equal(formatEventType("BOOT"), "Boot");
});

console.log("\n=== formatPublisher ===");

test("snake_case publisher becomes sentence case", () => {
  assert.equal(formatPublisher("oasis_lead_stage_engine"), "Oasis lead stage engine");
});

test("hyphenated publisher works too", () => {
  assert.equal(formatPublisher("manifest-data"), "Manifest data");
});

test("simple lowercase publisher gets capitalized", () => {
  assert.equal(formatPublisher("bravo"), "Bravo");
});

test("empty / non-string returns empty string", () => {
  assert.equal(formatPublisher(""), "");
  assert.equal(formatPublisher(null as unknown as string), "");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
