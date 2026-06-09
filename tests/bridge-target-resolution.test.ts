/**
 * Tests for resolveBridgeTarget in lib/bridge-proxy.ts.
 *
 * Locks the per-tenant bridge URL resolution precedence shipped 2026-06-10
 * (commits 5971859 + post-Codex hardening). The function takes an injected
 * `env` so tests can pin each branch deterministically without mutating
 * process.env.
 *
 * Codex adversarial review 2026-06-10 caught three issues; all assertions
 * marked CODEX-HIGH or CODEX-MED below regress to a real reported finding
 * if they fail.
 *
 * Resolution rules under test:
 *
 *   1. tenant.custom_fields.bridge_url set + tenant-scoped token present
 *      → returns the per-tenant target.
 *
 *   2. tenant.custom_fields.bridge_url set + token MISSING
 *      → returns null (fail-closed; MUST NOT silently fall back to the
 *      global SunBiz bridge — that would misroute traffic AND leak the
 *      SunBiz bearer to the wrong machine).
 *
 *   3. SunBiz (slug='submissions') + global env set → returns the
 *      global target (only allowlisted tenant for global fallback).
 *
 *   4. Non-SunBiz tenant + no per-tenant override → null
 *      (CODEX-HIGH: prior code silently used the global SunBiz bridge
 *      for any operator-allowed tenant, leaking the SunBiz bearer).
 *
 *   5. bridge_url must be HTTPS — http:// falls closed.
 *
 *   6. Bearer env var name is SERVER-DERIVED from slug only.
 *      tenant.custom_fields.bridge_bearer_token_env is IGNORED
 *      (CODEX-HIGH: a corruptible row could otherwise point at
 *      BRIDGE_BEARER_TOKEN to exfiltrate the SunBiz bearer).
 *
 *   7. Trailing slashes on URLs are stripped.
 */

import assert from "node:assert/strict";
import { resolveBridgeTarget } from "../lib/bridge-target-resolver";

type Tenant = Parameters<typeof resolveBridgeTarget>[0];

function tenant(
  slug: string,
  custom_fields: Record<string, unknown> | null = null,
): Tenant {
  return { slug, custom_fields };
}

// ─────────────────────────────────────────────────────────────────────
// Rule 1 — per-tenant override + matching token → per-tenant target
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis", { bridge_url: "https://bridge-cc.oasisai.work" }),
    { BRIDGE_BEARER_TOKEN_OASIS: "oasis-token-abc" },
  );
  assert.deepEqual(
    r,
    { baseUrl: "https://bridge-cc.oasisai.work", bearerToken: "oasis-token-abc" },
    "per-tenant URL + matching token → per-tenant target",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rule 2 — per-tenant override + token MISSING → null (fail-closed)
// THIS IS THE SECURITY-CRITICAL ASSERTION. A regression here would
// route an operator's traffic to the wrong VPS.
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis", { bridge_url: "https://bridge-cc.oasisai.work" }),
    {
      // Per-tenant token NOT set, but global IS — we must NOT silently
      // fall through to the global. fail-closed = null.
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "sunbiz-bearer-XYZ",
    },
  );
  assert.equal(
    r,
    null,
    "per-tenant URL set + tenant-scoped token missing → null (NO global fallback)",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rule 3 — SunBiz + global env set → global target (backward compat)
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("submissions", null),
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "sunbiz-bearer-XYZ",
    },
  );
  assert.deepEqual(
    r,
    { baseUrl: "https://bridge.oasisai.work", bearerToken: "sunbiz-bearer-XYZ" },
    "SunBiz (no override) + global env → global target (backward compat)",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rule 4 — CODEX-HIGH: non-SunBiz with no override → null
// SunBiz-only allowlist for global fallback. Without this assertion,
// any operator-allowed tenant could silently use the SunBiz bearer.
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis", null), // operator's personal tenant, no per-tenant URL
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "sunbiz-bearer-XYZ",
    },
  );
  assert.equal(
    r,
    null,
    "OASIS tenant without per-tenant bridge_url → null (DOES NOT silently use SunBiz bridge)",
  );
}

{
  const r = resolveBridgeTarget(
    tenant("propflow", null),
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "sunbiz-bearer-XYZ",
    },
  );
  assert.equal(
    r,
    null,
    "any non-SunBiz tenant without per-tenant URL → null (fail closed)",
  );
}

// SunBiz with global env missing → null
{
  const r = resolveBridgeTarget(tenant("submissions", null), {});
  assert.equal(r, null, "SunBiz + no global env → null");
}

{
  const r = resolveBridgeTarget(
    tenant("submissions", null),
    { BRIDGE_VPS_URL: "https://bridge.oasisai.work" },
  );
  assert.equal(r, null, "SunBiz + global URL set but global token missing → null");
}

// ─────────────────────────────────────────────────────────────────────
// Rule 5 — CODEX-HIGH: HTTPS required for per-tenant bridge_url
// http:// would send the bearer in plaintext. fail-closed.
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis", { bridge_url: "http://bridge-cc.oasisai.work" }),
    { BRIDGE_BEARER_TOKEN_OASIS: "t" },
  );
  assert.equal(
    r,
    null,
    "http:// per-tenant bridge_url → null (HTTPS required for bearer)",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rule 6 — CODEX-HIGH: bearer env var name NOT configurable from row.
// A corrupted custom_fields can't point at BRIDGE_BEARER_TOKEN or any
// other tenant's bearer env to exfiltrate it.
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis", {
      bridge_url: "https://attacker.example.com",
      // Attacker tries to point at the SunBiz bearer env var
      bridge_bearer_token_env: "BRIDGE_BEARER_TOKEN",
    }),
    {
      // SunBiz bearer is loaded in the env, but the row's request to
      // read it MUST be ignored — only BRIDGE_BEARER_TOKEN_OASIS
      // (server-derived from slug) is consulted.
      BRIDGE_BEARER_TOKEN: "sunbiz-secret",
      // No BRIDGE_BEARER_TOKEN_OASIS set
    },
  );
  assert.equal(
    r,
    null,
    "tenant-controlled bridge_bearer_token_env is IGNORED — slug-derived name only",
  );
}

// Even when the attacker's claimed env var matches, the override is still
// ignored — the LEGITIMATE BRIDGE_BEARER_TOKEN_<SLUG> is the only source.
{
  const r = resolveBridgeTarget(
    tenant("oasis", {
      bridge_url: "https://bridge-cc.oasisai.work",
      bridge_bearer_token_env: "SOME_OTHER_VAR",
    }),
    {
      SOME_OTHER_VAR: "would-be-leaked",
      BRIDGE_BEARER_TOKEN_OASIS: "legit-oasis-bearer",
    },
  );
  assert.deepEqual(
    r,
    {
      baseUrl: "https://bridge-cc.oasisai.work",
      bearerToken: "legit-oasis-bearer",
    },
    "bridge_bearer_token_env always ignored — slug-derived BRIDGE_BEARER_TOKEN_OASIS wins",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rule 6b — slug hyphens are sanitized to underscores in env var name
// CC's actual OASIS tenant slug is "oasis-ai-cc" — POSIX env vars can't
// contain hyphens, and Vercel UI rejects them on form submit. The
// resolver MUST translate hyphens → underscores so the operator can
// set a sane var name.
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis-ai-cc", { bridge_url: "https://bridge-cc.oasisai.work" }),
    { "BRIDGE_BEARER_TOKEN_OASIS_AI_CC": "cc-personal-bearer" },
  );
  assert.deepEqual(
    r,
    {
      baseUrl: "https://bridge-cc.oasisai.work",
      bearerToken: "cc-personal-bearer",
    },
    "hyphenated slug 'oasis-ai-cc' → underscored env var BRIDGE_BEARER_TOKEN_OASIS_AI_CC",
  );
}

// And the WRONG var name (with hyphens) is NOT consulted — defense
// against a Vercel UI that accepted hyphens at one point but won't now.
{
  const r = resolveBridgeTarget(
    tenant("oasis-ai-cc", { bridge_url: "https://bridge-cc.oasisai.work" }),
    {
      // Wrong (hyphenated) form — must be IGNORED.
      "BRIDGE_BEARER_TOKEN_OASIS-AI-CC": "wrong-name-token",
      // No underscored form set → fail closed.
    },
  );
  assert.equal(
    r,
    null,
    "hyphen-form env var must NOT be consulted (only underscore form is canonical)",
  );
}

// Defense-in-depth: a hypothetical slug that contains other non-POSIX
// chars (only possible if SLUG_RE is ever loosened upstream) still
// produces a valid env var name — the resolver never silently emits
// a malformed name.
{
  const r = resolveBridgeTarget(
    // SLUG_RE today doesn't allow dots, but if it ever does, we don't
    // want the resolver to emit BRIDGE_BEARER_TOKEN_FOO.BAR (invalid).
    tenant("foo.bar", { bridge_url: "https://example.oasisai.work" }),
    { BRIDGE_BEARER_TOKEN_FOO_BAR: "hypothetical-bearer" },
  );
  assert.deepEqual(
    r,
    {
      baseUrl: "https://example.oasisai.work",
      bearerToken: "hypothetical-bearer",
    },
    "any non-[A-Z0-9_] char in slug is normalized to underscore in env var name",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rule 6 — trailing slash normalization
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("oasis", { bridge_url: "https://bridge-cc.oasisai.work///" }),
    { BRIDGE_BEARER_TOKEN_OASIS: "t" },
  );
  if (!r) throw new Error("expected non-null target");
  assert.equal(
    r.baseUrl,
    "https://bridge-cc.oasisai.work",
    "trailing slashes stripped from per-tenant URL",
  );
}

{
  const r = resolveBridgeTarget(
    tenant("submissions", null),
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work/////",
      BRIDGE_BEARER_TOKEN: "t",
    },
  );
  if (!r) throw new Error("expected non-null global target");
  assert.equal(
    r.baseUrl,
    "https://bridge.oasisai.work",
    "trailing slashes stripped from global URL",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Edge: whitespace-only bridge_url is treated as "no override" — falls
// through to the global-fallback rule. For non-SunBiz tenants, that's
// still null (per Rule 4). For SunBiz, it's the global target.
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    tenant("submissions", { bridge_url: "   " }),
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "t",
    },
  );
  assert.deepEqual(
    r,
    { baseUrl: "https://bridge.oasisai.work", bearerToken: "t" },
    "SunBiz + whitespace-only override → global fallback (treated as absent)",
  );
}

{
  const r = resolveBridgeTarget(
    tenant("oasis", { bridge_url: "   " }),
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "t",
    },
  );
  assert.equal(
    r,
    null,
    "OASIS + whitespace-only override → null (no SunBiz fallback for non-SunBiz)",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Edge: tenant.custom_fields is null
//   - SunBiz → global fallback
//   - Non-SunBiz → null (fail closed)
// ─────────────────────────────────────────────────────────────────────
{
  const r = resolveBridgeTarget(
    { slug: "submissions", custom_fields: null },
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "t",
    },
  );
  assert.ok(r, "SunBiz + null custom_fields → fall through to global");
  assert.equal(r?.baseUrl, "https://bridge.oasisai.work");
}

{
  const r = resolveBridgeTarget(
    { slug: "oasis", custom_fields: null },
    {
      BRIDGE_VPS_URL: "https://bridge.oasisai.work",
      BRIDGE_BEARER_TOKEN: "t",
    },
  );
  assert.equal(
    r,
    null,
    "OASIS + null custom_fields → null (no SunBiz fallback)",
  );
}

console.log("bridge-target-resolution: all assertions passed");
