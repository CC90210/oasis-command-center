/**
 * tests/device-reconnect.test.ts - Refresh in Settings > Devices reconnects a
 * computer that has been connected before (CC, 2026-10-27).
 *
 * CC's Mac read Offline for two weeks while he used it: its bridge process was
 * twenty days old and never ran the claim loop. Refresh now asks each of the
 * person's offline computers to reconnect, and the computer's next check-in
 * reply tells that bridge process to start fresh. Pins, through the real routes
 * on a real libSQL file with the real encryption:
 *
 *   1. The rule (lib/devices/reconnect.ts): the process that was running when
 *      Refresh asked is told, again until it restarts; a different process means
 *      the restart happened (no clock is compared, so a Mac clock behind the
 *      server's cannot loop it); a bridge too old to say when it started is not
 *      told; a request nobody picked up in 15 minutes is dropped; an unreadable
 *      one is dropped.
 *   2. POST /api/devices/[id]/reconnect: signed out 401, unknown 404, someone
 *      else's computer 403, a disconnected one 409, your own 200. Clicked again
 *      before the computer reconnected, it keeps the process it told (a fresh
 *      process is never restarted twice) and renews the 15 minutes.
 *   3. POST /api/bridge/ping answers reconnect true/false by that rule, end to end.
 *   4. The request is not a credential: the integrations status list skips it.
 *   5. The words (lib/devices/reconnect-words.ts): each computer by its own
 *      outcome; back, still checking in, or not checking in (switched off is
 *      never waited on), in singular and plural.
 *   6. The card: Refresh reads again and asks only your own Offline computers,
 *      then watches while one is checking in and says how each one went.
 *
 * Run: node --conditions=react-server --import tsx tests/device-reconnect.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "device-reconnect-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "device-reconnect-test-secret-long-enough-01";
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "device-reconnect-test-field-encryption-passphrase";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "BRAVO_DASHBOARD_URL"]) {
  delete process.env[k];
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
{
  const p = require.resolve("next/headers");
  require.cache[p] = {
    id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [],
    exports: {
      cookies: async () => ({
        get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
        getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
        has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
        set: () => undefined,
      }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const db: Client = createClient({ url: `file:${dbFile}` });

const TENANT = "d1d1d1d1-0000-4000-8000-0000000000d1";
const OWNER_ID = "auth-owner-reconnect-1";
const OTHER_ID = "auth-other-reconnect-1";
const stamp = "2026-10-27T00:00:00.000Z";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT, raw_user_meta_data TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claude_account_hash TEXT, previous_token_hash TEXT, token_rotated_at TEXT,
      last_poll_ok_at TEXT, claim_state_at TEXT, claim_capacity INTEGER,
      claim_in_flight INTEGER, claim_blocked_reason TEXT, claim_runtime_state TEXT);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      profile_id TEXT, service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX "integrations_health_profile_id_service_key" ON integrations_health (profile_id, service);
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tic_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
  `);
}

async function seed() {
  for (const t of ["tenants", "_supabase_auth_users", "user_profiles", "bridge_pairings", "integrations_health", "tenant_integration_credentials"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-r', 'Client R')", args: [TENANT] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OWNER_ID, "owner@client-r.test"] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OTHER_ID, "other@client-r.test"] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-owner', ?, 'owner@client-r.test', ?, 'owner', 1, 'Owner', ?, ?)`,
        args: [OWNER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-other', ?, 'other@client-r.test', ?, 'admin', 0, 'Other', ?, ?)`,
        args: [OTHER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, scope, claim_enabled_at)
              VALUES ('bp-mac', ?, ?, 'Your Mac', ?, 'fp-mac', 'connector', ?)`,
        args: [TENANT, OWNER_ID, sha256("mac-token"), stamp],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, scope, revoked_at)
              VALUES ('bp-old', ?, ?, 'Old PC', ?, 'fp-old', 'connector', ?)`,
        args: [TENANT, OWNER_ID, sha256("old-token"), stamp],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, scope)
              VALUES ('bp-other', ?, ?, 'Their laptop', ?, 'fp-other', 'connector')`,
        args: [TENANT, OTHER_ID, sha256("other-token")],
      },
    ],
    "write",
  );
}

async function login(authUserId: string, email: string) {
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: authUserId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await seed();
    sessionCookie = undefined;
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  await createSchema();
  const rule = await import("../lib/devices/reconnect");
  const words = await import("../lib/devices/reconnect-words");
  const store = await import("../lib/tenant-integration-store");
  const reconnectRoute = await import("../app/api/devices/[id]/reconnect/route");
  const pingRoute = await import("../app/api/bridge/ping/route");
  const ask = (id: string) =>
    reconnectRoute.POST(new NextRequest(`https://oasisai.work/api/devices/${id}/reconnect`, { method: "POST" }), { params: Promise.resolve({ id }) });
  const ping = async (body: Record<string, unknown>, token = "mac-token") => {
    const res = await pingRoute.POST(
      new NextRequest("https://oasisai.work/api/bridge/ping", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    return (await res.json()) as { reconnect?: boolean };
  };
  const stored = async () => {
    const raw = await store.getTenantIntegrationValue(TENANT, store.BRIDGE_RECONNECT_SERVICE, "bp-mac");
    return raw ? JSON.parse(raw) : null;
  };
  const S1 = "2026-10-07T04:00:00.000000+00:00";
  const S2 = "2026-10-27T06:13:00.000000+00:00";

  console.log("device reconnect:");

  await check("the rule: the process told is told until it restarts; no clock is compared", () => {
    const now = Date.parse("2026-10-27T06:00:00Z");
    const req = { requested_at: "2026-10-27T05:59:00Z", told: null };
    assert.deepEqual(rule.reconnectDecision(null, S1, now), { reconnect: false, next: "keep" });
    assert.deepEqual(rule.reconnectDecision(req, S1, now), { reconnect: true, next: { ...req, told: S1 } });
    assert.deepEqual(rule.reconnectDecision({ ...req, told: S1 }, S1, now), { reconnect: true, next: "keep" }, "still waiting for a job to finish");
    assert.deepEqual(rule.reconnectDecision({ ...req, told: S1 }, S2, now), { reconnect: false, next: null }, "a new process: done");
    // A Mac clock two hours behind: its fresh process says it started BEFORE the request, and is still not looped.
    const behind = "2026-10-27T04:00:30.000000+00:00";
    assert.deepEqual(rule.reconnectDecision({ ...req, told: S1 }, behind, now), { reconnect: false, next: null });
    assert.deepEqual(rule.reconnectDecision(req, null, now), { reconnect: false, next: "keep" }, "a bridge too old to say cannot act");
    assert.deepEqual(rule.reconnectDecision(req, S1, now + rule.RECONNECT_EXPIRES_MS + 61_000), { reconnect: false, next: null }, "nobody picked it up: dropped");
    assert.equal(rule.parseReconnectRequest("not json"), null);
    assert.equal(rule.parseReconnectRequest('{"requested_at":"nope"}'), null);
    assert.equal(rule.processStamp("x".repeat(65)), null);
    assert.equal(rule.processStamp(12), null);
    assert.equal(rule.processStamp(S1), S1);
    // Refresh clicked again: renewed, still the process told; an expired one starts over.
    const told = { requested_at: "2026-10-27T05:59:00.000Z", told: S1 };
    assert.deepEqual(rule.renewedRequest(told, now), { requested_at: new Date(now).toISOString(), told: S1 });
    assert.deepEqual(rule.renewedRequest(null, now), { requested_at: new Date(now).toISOString(), told: null });
    const lapsed = now + rule.RECONNECT_EXPIRES_MS + 61_000;
    assert.deepEqual(rule.renewedRequest(told, lapsed), { requested_at: new Date(lapsed).toISOString(), told: null });
  });

  await check("the route: signed out 401, unknown 404, someone else's 403, disconnected 409, your own 200", async () => {
    assert.equal((await ask("bp-mac")).status, 401);
    await login(OWNER_ID, "owner@client-r.test");
    assert.equal((await ask("bp-nope")).status, 404);
    assert.equal((await ask("bp-other")).status, 403, "not even an admin restarts another person's computer");
    assert.equal((await ask("bp-old")).status, 409);
    const own = await ask("bp-mac");
    assert.equal(own.status, 200);
    const j = (await own.json()) as { ok: boolean; requested_at: string };
    assert.equal(j.ok, true);
    assert.deepEqual(await stored(), { requested_at: j.requested_at, told: null });
    await login(OTHER_ID, "other@client-r.test");
    assert.equal((await ask("bp-mac")).status, 403);
  });

  await check("the check-in: told until the process changes, then the request is gone", async () => {
    assert.equal((await ping({ services: {}, started_at: S1 })).reconnect, false, "nothing asked");
    await login(OWNER_ID, "owner@client-r.test");
    await ask("bp-mac");
    assert.equal((await ping({ services: {} })).reconnect, false, "an old bridge cannot act on it");
    assert.equal((await ping({ services: {}, started_at: S1 })).reconnect, true);
    assert.equal((await stored()).told, S1);
    assert.equal((await ping({ services: {}, started_at: S1 })).reconnect, true, "busy: told again until it restarts");
    assert.equal((await ping({ services: {}, started_at: S2 })).reconnect, false, "restarted");
    assert.equal(await stored(), null, "and the request is cleared");
    assert.equal((await ping({ services: {}, started_at: S2 })).reconnect, false);
  });

  await check("Refresh clicked twice: the process told stays told, and the fresh process is not restarted again", async () => {
    await login(OWNER_ID, "owner@client-r.test");
    assert.equal((await ask("bp-mac")).status, 200);
    assert.equal((await ping({ services: {}, started_at: S1 })).reconnect, true);
    assert.equal((await ask("bp-mac")).status, 200, "clicked again while S1 is restarting");
    assert.equal((await stored()).told, S1, "still S1");
    assert.equal((await ping({ services: {}, started_at: S2 })).reconnect, false, "S2 is the restart, not a new target");
    assert.equal(await stored(), null);
  });

  await check("an old or unreadable request is dropped, never acted on", async () => {
    const old = new Date(Date.now() - rule.RECONNECT_EXPIRES_MS - 60_000).toISOString();
    await store.setTenantIntegrationValue({ tenantId: TENANT, service: store.BRIDGE_RECONNECT_SERVICE, fieldKey: "bp-mac", value: JSON.stringify({ requested_at: old, told: null }) });
    assert.equal((await ping({ services: {}, started_at: S1 })).reconnect, false);
    assert.equal(await stored(), null);
    await store.setTenantIntegrationValue({ tenantId: TENANT, service: store.BRIDGE_RECONNECT_SERVICE, fieldKey: "bp-mac", value: "garbled" });
    assert.equal((await ping({ services: {}, started_at: S1 })).reconnect, false);
    assert.equal(await stored(), null);
  });

  await check("a reconnect request is not a credential: the status list skips it", async () => {
    await login(OWNER_ID, "owner@client-r.test");
    await ask("bp-mac");
    const rows = await store.listTenantIntegrationStatus(TENANT);
    assert.ok(rows.every((r) => r.service !== store.BRIDGE_RECONNECT_SERVICE));
  });

  await check("the words: each computer by its own outcome, never waiting on one switched off", () => {
    const now = Date.parse("2026-10-27T06:00:00Z");
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    const row = (id: string, label: string | null, seenS: number | null, claimS: number | null) => ({
      id, label, revoked_at: null,
      last_seen_at: seenS === null ? null : ago(seenS),
      claim_enabled_at: ago(86_400), claim_state_at: claimS === null ? null : ago(claimS),
      claim_blocked_reason: null, claim_capacity: 1,
    });
    const mac = row("m", "192.168.11.27 (Mac)", 20, 400); // checking in, not claiming: the 2026-10-27 Mac
    const pc = row("p", "CCPC (Windows)", 5 * 86_400, 5 * 86_400); // off since Oct 22
    assert.equal(words.readsOffline(mac, now), true);
    // Last seen 5 minutes ago: not pinging each minute, so asleep or off, never waited on.
    assert.deepEqual(words.reconnectOutcome(["i"], [row("i", "Laptop", 300, 400)], now), { back: [], checkingIn: [], quiet: ["Laptop"] });
    assert.equal(words.readsOffline(row("x", "x", 20, 10), now), false);

    let o = words.reconnectOutcome(["m", "p"], [mac, pc], now);
    assert.deepEqual(o, { back: [], checkingIn: ["192.168.11.27 (Mac)"], quiet: ["CCPC (Windows)"] });
    assert.equal(words.reconnectWaiting(o), true);
    assert.equal(
      words.reconnectWords(o, false),
      "Asking 192.168.11.27 (Mac) to reconnect. A computer checks in about once a minute. " +
        "CCPC (Windows) isn't checking in. If it's asleep or switched off, wake it: it reconnects by itself within a minute.",
    );
    // The Mac restarted and claims; the PC is still off: nothing left to wait for.
    o = words.reconnectOutcome(["m", "p"], [{ ...mac, claim_state_at: ago(3) }, pc], now);
    assert.equal(words.reconnectWaiting(o), false);
    assert.equal(
      words.reconnectWords(o, true),
      "192.168.11.27 (Mac) reconnected. CCPC (Windows) isn't checking in. If it's asleep or switched off, wake it: it reconnects by itself within a minute.",
    );
    // Still checking in but never reconnected by the end of the watch: restart it.
    assert.equal(
      words.reconnectWords(words.reconnectOutcome(["m"], [mac], now), true),
      "192.168.11.27 (Mac) is checking in but hasn't reconnected. If it still reads Offline in a few minutes, restart that computer.",
    );
    // Plural, and a computer disconnected meanwhile is left out.
    const two = words.reconnectOutcome(["m", "p", "gone"], [mac, { ...pc, last_seen_at: ago(30) }], now);
    assert.equal(
      words.reconnectWords(two, true),
      "192.168.11.27 (Mac) and CCPC (Windows) are checking in but haven't reconnected. If they still read Offline in a few minutes, restart those computers.",
    );
    assert.equal(
      words.reconnectWords({ back: [], checkingIn: [], quiet: ["A", "B", "C"] }, false),
      "A, B and C aren't checking in. If they're asleep or switched off, wake them: they reconnect by themselves within a minute.",
    );
    assert.equal(words.reconnectWords(words.reconnectOutcome(["m"], [{ ...mac, revoked_at: ago(1) }], now), true), "");
    assert.equal(words.reconnectWords(words.reconnectOutcome(["n"], [row("n", null, 20, 400)], now), false), "Asking your computer to reconnect. A computer checks in about once a minute.");
  });

  await check("the card: Refresh asks only your own Offline computers, watches while one is checking in, and says how each went", () => {
    const card = read("components/settings/YourComputersCard.tsx");
    assert.match(card, /onClick=\{\(\) => void refresh\(\)\}/, "the refresh button reconnects, not only reloads");
    assert.match(card, /const offline = rows\.filter\(\(d\) => d\.mine && !d\.revoked_at && readsOffline\(d, Date\.now\(\)\)\);/);
    assert.match(card, /fetch\(`\/api\/devices\/\$\{encodeURIComponent\(d\.id\)\}\/reconnect`, \{ method: "POST" \}\)/);
    assert.match(card, /Couldn't ask \$\{namesSentence\(missed\)\} to reconnect\./, "a computer that was not asked is named");
    assert.match(card, /setReconnect\(\{ ids: asked, since: now, done: !reconnectWaiting\(reconnectOutcome\(asked, rows, now\)\) \}\);/);
    assert.match(card, /if \(!waiting \|\| nowMs - reconnect\.since >= RECONNECT_WATCH_MS\) setReconnect\(\{ \.\.\.reconnect, done: true \}\);/);
    assert.match(card, /reconnectWords\(reconnectOutcome\(reconnect\.ids, devices, now\), reconnect\.done\)/, "the line reads the rows on screen");
    assert.match(card, /<span role="status"[^>]*data-testid="computers-reconnect-status">\s*\{reconnectLine\}/, "one live region, always there");
    assert.match(card, /window\.setTimeout\(\(\) => setReconnect\(null\), 15_000\)/, "a success line does not outlive the moment");
  });

  console.log(failures ? `device reconnect: ${failures} failure(s)` : "device reconnect: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
