import assert from "node:assert/strict";
import { computeEffectiveBridgeOnline } from "../lib/bridge-effective-online";

// Regression locks for the 2026-06-09 bridge-dropdown-still-offline incident.
//
// Production logs revealed the Vercel→VPS proxy was 503-ing on every
// /api/bridge/health probe (BRIDGE_VPS_URL or BRIDGE_BEARER_TOKEN cleared
// in an encryption-key rotation), while the bridge daemon itself was
// heartbeating outbound to /api/bridge/ping every 30s. The previous gate
// required isProxyModeRuntime() AND serverBridgeOnline; both signals
// independent now.
//
// These tests pin all four state combinations. If a future "tighten the
// gate" pass re-introduces the proxyMode requirement (and the same Matt
// bug returns), these fail.

// ---- 1. Both signals true → online. The healthy case. ----
assert.equal(
  computeEffectiveBridgeOnline(true, true),
  true,
  "bridgeOnline=true + serverBridgeOnline=true → online",
);

// ---- 2. Only the client probe says true → still online. ----
// Localhost operator scenario: serverBridgeOnline may be undefined or
// false, but the local probe succeeded.
assert.equal(
  computeEffectiveBridgeOnline(true, false),
  true,
  "bridgeOnline=true alone is sufficient (operator localhost)",
);
assert.equal(
  computeEffectiveBridgeOnline(true, undefined),
  true,
  "bridgeOnline=true + serverBridgeOnline=undefined → online",
);

// ---- 3. Only the server signal says true → STILL online. ----
// This is the Matt-incident case the round-3 fix targeted. The bridge
// daemon is alive (DB heartbeat fresh from outbound ping) but the
// Vercel→VPS proxy is broken (env vars cleared), so the client probe
// returns false. We MUST treat this as online so the dropdown is usable.
assert.equal(
  computeEffectiveBridgeOnline(false, true),
  true,
  "serverBridgeOnline=true alone is sufficient (daemon up, proxy degraded)",
);
assert.equal(
  computeEffectiveBridgeOnline(null, true),
  true,
  "serverBridgeOnline=true with probe-inflight → online",
);

// ---- 4. Both signals say down → offline. ----
// Probe completed (not null) AND server says no fresh heartbeat. Block.
assert.equal(
  computeEffectiveBridgeOnline(false, false),
  false,
  "both signals false → offline",
);
assert.equal(
  computeEffectiveBridgeOnline(false, undefined),
  false,
  "bridgeOnline=false + serverBridgeOnline=undefined → offline",
);

// ---- 5. Initial state (probe inflight, no server data) → offline. ----
// During the first 1500ms after mount the probe hasn't completed yet AND
// the prop might be undefined. Block until at least one signal resolves.
assert.equal(
  computeEffectiveBridgeOnline(null, undefined),
  false,
  "both unknown → offline (until at least one resolves)",
);
assert.equal(
  computeEffectiveBridgeOnline(null, false),
  false,
  "probe inflight + server says no → offline",
);

console.log("bridge-effective-online.test.ts: OK");
