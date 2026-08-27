import assert from "node:assert/strict";
import { probeRefreshToken } from "../lib/integrations/google-token-probe";

/**
 * tests/google-token-probe.test.ts
 *
 * This module is the single answer to "is this Google credential spendable",
 * shared by the handoff readiness banner and the workspace-calendar watchdog.
 * The 2026-08-26 outage was two surfaces asking that question differently and
 * getting different answers, so the three-state contract is the thing under
 * test here — especially that `unknown` is distinct from both.
 */

const CREDS = {
  refreshToken: "refresh-value",
  clientId: "client-value",
  clientSecret: "secret-value",
};

const ok = () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 });

async function run() {
  // ─── live ────────────────────────────────────────────────────────────────
  assert.equal(
    await probeRefreshToken({ ...CREDS, fetchImpl: (async () => ok()) as typeof fetch }),
    "live",
  );

  // ─── dead: every 4xx, not just the one we happened to see ────────────────
  for (const [status, label] of [
    [400, "invalid_grant — revoked or withdrawn"],
    [401, "invalid_client — minted by a different OAuth client (#331)"],
    [403, "forbidden"],
  ] as const) {
    assert.equal(
      await probeRefreshToken({
        ...CREDS,
        fetchImpl: (async () => new Response("{}", { status })) as typeof fetch,
      }),
      "dead",
      `${status} must be dead: ${label}`,
    );
  }

  // ─── unknown: Google could not be ASKED ──────────────────────────────────
  // The case that must never be collapsed into live or dead. Both callers
  // depend on being able to tell "no" apart from "no answer", and they act on
  // it differently on purpose.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(
      await probeRefreshToken({
        ...CREDS,
        fetchImpl: (async () => new Response("upstream", { status })) as typeof fetch,
      }),
      "unknown",
      `${status} is Google's problem and says nothing about the credential`,
    );
  }
  assert.equal(
    await probeRefreshToken({
      ...CREDS,
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    }),
    "unknown",
    "a transport failure is not a rejection",
  );

  // ─── missing inputs are dead, and cost no network call ───────────────────
  for (const missing of [
    { refreshToken: "" },
    { clientId: "" },
    { clientSecret: "" },
  ]) {
    let called = false;
    const verdict = await probeRefreshToken({
      ...CREDS,
      ...missing,
      fetchImpl: (async () => {
        called = true;
        return ok();
      }) as typeof fetch,
    });
    assert.equal(verdict, "dead", `${Object.keys(missing)[0]} empty must be dead`);
    assert.equal(called, false, "an incomplete credential must not hit Google");
  }

  // ─── the credential is presented with the client it was given ────────────
  // Not the ambient one. Spending a workspace credential with the rep-facing
  // client is #331, and it returns invalid_client — a failure that looks like
  // revocation and sends people to the wrong remedy.
  let body = "";
  await probeRefreshToken({
    refreshToken: "workspace-refresh",
    clientId: "workspace-client",
    clientSecret: "workspace-secret",
    fetchImpl: (async (_u: unknown, init: RequestInit) => {
      body = String(init?.body || "");
      return ok();
    }) as typeof fetch,
  });
  assert.ok(body.includes("refresh_token=workspace-refresh"), "must send the given credential");
  assert.ok(body.includes("client_id=workspace-client"), "must send the given client");
  assert.ok(body.includes("client_secret=workspace-secret"), "must send the given secret");
  assert.ok(body.includes("grant_type=refresh_token"), "must be a refresh grant");

  console.log("google-token-probe: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
