/**
 * Tests for validateBridgeAgent + allowedBridgeAgentsForTenant in
 * lib/agent-roots.ts. These are pure functions with no Supabase calls
 * — direct import + invoke pattern matches role-agent-defaults.test.ts.
 *
 * Locks the per-tenant bridge agent allowlist:
 *   - SunBiz tenant (slug='submissions') → only solara + helios
 *   - Operator (CC) personal OASIS tenant or any other slug →
 *     bravo + atlas + maven + aura + hermes + life-preservation
 *
 * Recurrence prevention for the 2026-06-09 OASIS invalid_agent bug:
 * /api/bridge/chat hardcoded ALLOWED_BRIDGE_AGENTS={solara,helios}, so
 * CC's personal OASIS Command Center rejected agent=bravo as
 * invalid_agent. This file pins the matrix so a future refactor can't
 * silently re-lock the OASIS branch.
 */

import assert from "node:assert/strict";
import {
  KNOWN_BRIDGE_AGENTS,
  SUNBIZ_BRIDGE_AGENTS,
  OASIS_BRIDGE_AGENTS,
  allowedBridgeAgentsForTenant,
  validateBridgeAgent,
} from "../lib/agent-roots";

// ─────────────────────────────────────────────────────────────────────
// Set membership
// ─────────────────────────────────────────────────────────────────────

assert.equal(SUNBIZ_BRIDGE_AGENTS.has("solara"), true, "solara is SunBiz");
assert.equal(SUNBIZ_BRIDGE_AGENTS.has("helios"), true, "helios is SunBiz");
assert.equal(SUNBIZ_BRIDGE_AGENTS.has("bravo"), false, "bravo NOT in SunBiz");
assert.equal(SUNBIZ_BRIDGE_AGENTS.size, 2, "SunBiz set has exactly 2 agents");

assert.equal(OASIS_BRIDGE_AGENTS.has("bravo"), true, "bravo is OASIS");
assert.equal(OASIS_BRIDGE_AGENTS.has("atlas"), true, "atlas is OASIS");
assert.equal(OASIS_BRIDGE_AGENTS.has("maven"), true, "maven is OASIS");
assert.equal(OASIS_BRIDGE_AGENTS.has("aura"), true, "aura is OASIS");
assert.equal(OASIS_BRIDGE_AGENTS.has("hermes"), true, "hermes is OASIS");
assert.equal(
  OASIS_BRIDGE_AGENTS.has("life-preservation"),
  true,
  "life-preservation is OASIS",
);
assert.equal(OASIS_BRIDGE_AGENTS.has("solara"), false, "solara NOT in OASIS");
assert.equal(OASIS_BRIDGE_AGENTS.has("helios"), false, "helios NOT in OASIS");

// KNOWN is the union.
assert.equal(
  KNOWN_BRIDGE_AGENTS.size,
  SUNBIZ_BRIDGE_AGENTS.size + OASIS_BRIDGE_AGENTS.size,
  "KNOWN is the disjoint union (no overlap)",
);

// ─────────────────────────────────────────────────────────────────────
// allowedBridgeAgentsForTenant — slug-based discrimination
// ─────────────────────────────────────────────────────────────────────

assert.equal(
  allowedBridgeAgentsForTenant("submissions"),
  SUNBIZ_BRIDGE_AGENTS,
  "SunBiz slug → SUNBIZ set",
);
assert.equal(
  allowedBridgeAgentsForTenant("oasis"),
  OASIS_BRIDGE_AGENTS,
  "OASIS slug → OASIS set",
);
assert.equal(
  allowedBridgeAgentsForTenant(""),
  OASIS_BRIDGE_AGENTS,
  "empty slug falls to OASIS (operator default)",
);
assert.equal(
  allowedBridgeAgentsForTenant("unknown-tenant"),
  OASIS_BRIDGE_AGENTS,
  "unknown slug falls to OASIS (operator default)",
);

// ─────────────────────────────────────────────────────────────────────
// validateBridgeAgent — the canonical two-gate check
// ─────────────────────────────────────────────────────────────────────

// SunBiz happy path
{
  const r = validateBridgeAgent("solara", "submissions");
  assert.equal(r.ok, true, "SunBiz + solara → ok");
}
{
  const r = validateBridgeAgent("helios", "submissions");
  assert.equal(r.ok, true, "SunBiz + helios → ok");
}

// SunBiz reject OASIS agents (this is the security boundary)
{
  const r = validateBridgeAgent("bravo", "submissions");
  assert.equal(r.ok, false, "SunBiz + bravo → reject");
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.error, "agent_not_enabled_for_tenant");
  }
}
{
  const r = validateBridgeAgent("atlas", "submissions");
  assert.equal(r.ok, false, "SunBiz + atlas → reject");
}

// OASIS happy path (the bug from 2026-06-09 — must not regress)
{
  const r = validateBridgeAgent("bravo", "oasis");
  assert.equal(r.ok, true, "OASIS + bravo → ok (the bug fix)");
}
{
  const r = validateBridgeAgent("atlas", "oasis");
  assert.equal(r.ok, true, "OASIS + atlas → ok");
}
{
  const r = validateBridgeAgent("maven", "oasis");
  assert.equal(r.ok, true, "OASIS + maven → ok");
}

// OASIS reject SunBiz agents
{
  const r = validateBridgeAgent("solara", "oasis");
  assert.equal(r.ok, false, "OASIS + solara → reject (the inverse)");
  if (!r.ok) {
    assert.equal(r.error, "agent_not_enabled_for_tenant");
  }
}
{
  const r = validateBridgeAgent("helios", "oasis");
  assert.equal(r.ok, false, "OASIS + helios → reject");
}

// Unknown agent slug — invalid_agent (not agent_not_enabled_for_tenant)
{
  const r = validateBridgeAgent("madeup", "oasis");
  assert.equal(r.ok, false, "unknown slug → reject");
  if (!r.ok) {
    assert.equal(r.error, "invalid_agent", "unknown → invalid_agent not enabled");
  }
}
{
  const r = validateBridgeAgent("", "oasis");
  assert.equal(r.ok, false, "empty agent → reject");
  if (!r.ok) {
    assert.equal(r.error, "invalid_agent");
  }
}

// Edge: an OASIS tenant cannot request an OASIS-shaped string that
// isn't actually in OASIS_BRIDGE_AGENTS. Defense-in-depth.
{
  const r = validateBridgeAgent("BRAVO", "oasis"); // uppercase
  assert.equal(r.ok, false, "case-sensitive — uppercase rejected");
}

console.log("bridge-agent-validation: all assertions passed");
