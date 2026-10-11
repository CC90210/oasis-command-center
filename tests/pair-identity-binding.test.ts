/**
 * POST /api/auth/pair pairs only the person who proved who they are (O0).
 * Run: node --conditions=react-server --import tsx tests/pair-identity-binding.test.ts
 *
 * WHY. The route took the person from the request body. With the HMAC headers
 * (x-oasis-profile-id + x-oasis-secret, the bridge's self-pair on boot),
 * body.email won over the proven profile and body.auth_user_id was looked up
 * first, so whoever held ONE person's HMAC secret could pair as anyone, in any
 * workspace, rewrite that person's profile and overwrite that workspace's AI
 * keys. The shared CLI_SIGNUP_SECRET, which every setup-wizard machine holds,
 * could do the same to any account.
 *
 * What this pins, through the real route, the real Turso adapter and a local
 * libSQL file (no stand-in for the data layer):
 *   HMAC headers
 *   - a body naming person B by email pairs the proven A and writes nothing to
 *     B's workspace: B's profile, its AI keys and its computers are untouched;
 *   - a body naming B by auth_user_id pairs A;
 *   - the bridge's own self-pair body (machine details only, CEO-Agent
 *     bravo_cli/bridge_chat_server.py _self_pair_if_needed) still pairs its own
 *     profile, and pairing the same machine again rotates its own row;
 *   - a machine fingerprint that is a teammate's live computer is refused with
 *     409 machine_paired_to_another_person, and keeps its token (the
 *     fingerprint is self-reported, so it cannot pick the row either); a live
 *     computer with no recorded owner gets its own 409
 *     machine_pairing_has_no_owner, not the same "another person" wording;
 *   - a proven profile with no workspace is refused before anything is written;
 *   - a DEACTIVATED member's still-live HMAC secret is refused (403
 *     seat_inactive) and writes nothing (O0 review, HIGH);
 *   - an HMAC-proven profile that is not an owner or admin is refused (403
 *     admin_required) when it sends api_keys, and the workspace's keys are
 *     unchanged; the same call with no api_keys still succeeds (O0 review,
 *     MEDIUM);
 *   - an HMAC-proven profile with NO sign-in account (auth_user_id NULL) is
 *     refused up front (412 profile_has_no_sign_in) on every attempt, never
 *     creates an unowned row, and never hits the 409 "another person" re-pair
 *     trap (O0 review, LOW).
 *   CLI_SIGNUP_SECRET
 *   - an established account gets 403 use_a_pair_code and nothing is written,
 *     api_keys included. Each condition is pinned on its own: onboarding
 *     finished, a profile older than an hour, a workspace older than an hour
 *     (a brand-new member of an established workspace), and the hour itself
 *     (55 minutes pairs, 65 does not);
 *   - an account the installer provisioned within the hour pairs as before, and
 *     its keys are seeded into its own new workspace only;
 *   - an owner-claim invite accepted minutes ago into an operator-provisioned
 *     workspace (redeem_tenant_invite's invited_by, not signup_tenant's) is
 *     refused the same way, even though both the profile and its workspace
 *     are within the hour (O0 review, MEDIUM).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

// ── Environment, before any app module loads ──────────────────────────────
const dbFile = join(mkdtempSync(join(tmpdir(), "pair-identity-binding-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
// Never reach a hosted database or Supabase, whatever the shell holds.
for (const k of [
  "TURSO_DATABASE_URL",
  "TURSO_DB_URL",
  "TURSO_AUTH_TOKEN",
  "BRAVO_SUPABASE_URL",
  "BRAVO_SUPABASE_SERVICE_ROLE_KEY",
  "BRAVO_DASHBOARD_URL",
]) {
  delete process.env[k];
}
const SIGNUP_SECRET = "pair-identity-binding-signup-secret-0001";
process.env.CLI_SIGNUP_SECRET = SIGNUP_SECRET;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "pair-identity-binding-field-key-000001";

// lib/supabase-server imports next/headers; nothing here reads a cookie.
{
  const p = require.resolve("next/headers");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const LONG_AGO = "2026-01-05T12:00:00.000Z";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const TA = "a0000000-0000-4000-8000-0000000000a1"; // A's established workspace
const TB = "b0000000-0000-4000-8000-0000000000b1"; // B's established workspace
const TN = "c0000000-0000-4000-8000-0000000000c1"; // provisioned 55 minutes ago
const TO = "d0000000-0000-4000-8000-0000000000d1"; // provisioned 65 minutes ago
const TP = "e0000000-0000-4000-8000-0000000000e1"; // created minutes ago, for an older profile
const TQ = "f0000000-0000-4000-8000-0000000000f1"; // created minutes ago, already onboarded
const TX = "99000000-0000-4000-8000-000000000099"; // a client workspace an operator provisioned 20 minutes ago
const ALL_TENANTS = [TA, TB, TN, TO, TP, TQ, TX];

type Person = {
  profileId: string;
  authId: string | null;
  email: string;
  tenant: string | null;
  /** Minutes before the check runs; null means LONG_AGO. */
  createdMinutesAgo: number | null;
  onboarded: boolean;
};
const A: Person = { profileId: "a1111111-1111-4111-8111-111111111111", authId: "auth-a", email: "a@ws-a.test", tenant: TA, createdMinutesAgo: null, onboarded: true };
const C: Person = { profileId: "a2222222-2222-4222-8222-222222222222", authId: "auth-c", email: "c@ws-a.test", tenant: TA, createdMinutesAgo: null, onboarded: true };
const B: Person = { profileId: "b1111111-1111-4111-8111-111111111111", authId: "auth-b", email: "b@ws-b.test", tenant: TB, createdMinutesAgo: null, onboarded: true };
// Just provisioned by the installer: a fresh profile in a fresh workspace, not onboarded.
const N: Person = { profileId: "c1111111-1111-4111-8111-111111111111", authId: "auth-n", email: "n@new.test", tenant: TN, createdMinutesAgo: 55, onboarded: false };
// A member invited into A's established workspace minutes ago: a fresh profile, not onboarded.
const M: Person = { profileId: "a3333333-3333-4333-8333-333333333333", authId: "auth-m", email: "m@ws-a.test", tenant: TA, createdMinutesAgo: 5, onboarded: false };
// Never onboarded, but provisioned (profile and workspace) 65 minutes ago: just past the hour.
const O: Person = { profileId: "d1111111-1111-4111-8111-111111111111", authId: "auth-o", email: "o@old.test", tenant: TO, createdMinutesAgo: 65, onboarded: false };
// A profile from two hours ago, attached to a workspace created minutes ago.
const P: Person = { profileId: "e1111111-1111-4111-8111-111111111111", authId: "auth-p", email: "p@late.test", tenant: TP, createdMinutesAgo: 120, onboarded: false };
// Profile and workspace created minutes ago, but onboarding already finished.
const Q: Person = { profileId: "f1111111-1111-4111-8111-111111111111", authId: "auth-q", email: "q@done.test", tenant: TQ, createdMinutesAgo: 5, onboarded: true };
// An HMAC-holding profile that never got a workspace.
const T: Person = { profileId: "a4444444-4444-4444-8444-444444444444", authId: "auth-t", email: "t@nowhere.test", tenant: null, createdMinutesAgo: null, onboarded: false };
// A member of A's workspace, removed 30 minutes ago; its HMAC secret is still live.
const D: Person = { profileId: "a5555555-5555-4555-8555-555555555555", authId: "auth-d", email: "d@ws-a.test", tenant: TA, createdMinutesAgo: null, onboarded: true };
// An HMAC-holding profile in A's workspace with no sign-in account at all.
const H: Person = { profileId: "a6666666-6666-4666-8666-666666666666", authId: null, email: "h@ws-a.test", tenant: TA, createdMinutesAgo: null, onboarded: true };
// Accepted an operator's owner-claim invite into TX 5 minutes ago (redeem_tenant_invite:
// invited_by set, is_owner 1, not onboarded) — not an account the setup CLI provisioned.
const X: Person = { profileId: "99999999-9999-4999-8999-999999999999", authId: "auth-x", email: "owner@client-x.test", tenant: TX, createdMinutesAgo: 5, onboarded: false };
const PEOPLE = [A, B, C, N, M, O, P, Q, T, D, H, X];
const TENANT_AGE_MINUTES: Record<string, number | null> = { [TA]: null, [TB]: null, [TN]: 55, [TO]: 65, [TP]: 5, [TQ]: 5, [TX]: 20 };

const HMAC_A = "hmac-secret-for-profile-a-0001";
const HMAC_B = "hmac-secret-for-profile-b-0001";
const HMAC_T = "hmac-secret-for-profile-t-0001";
const HMAC_C = "hmac-secret-for-profile-c-0001";
const HMAC_D = "hmac-secret-for-profile-d-0001";
const HMAC_H = "hmac-secret-for-profile-h-0001";
const LEGACY_FINGERPRINT = "1e9ac71e9ac71e9ac71e9ac71e9ac700"; // a pairing from before owners were recorded
const LEGACY_TOKEN_HASH = "legacy-original-token-hash";
const C_FINGERPRINT = "c0ffee00c0ffee00c0ffee00c0ffee00"; // C's live computer
const C_TOKEN_HASH = "c-original-token-hash";
const B_FINGERPRINT = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"; // B's live computer
const B_TOKEN_HASH = "b-original-token-hash";
const B_ORIGINAL_KEY = "sk-or-b-original-key-do-not-overwrite";
const A_ORIGINAL_KEY = "sk-or-a-original-key-do-not-overwrite";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const db: Client = createClient({ url: `file:${dbFile}` });

async function createSchema() {
  // The columns the route and its helpers touch, shaped like production
  // (tests/_onboarding-fixture.ts; agent_model_config's partial unique indexes
  // as in tests/ai-workspace-account.test.ts; bridge_pairings' one-live-row-per-
  // machine partial unique index as the route documents it).
  await db.executeMultiple(`
    CREATE TABLE tenants (
      id TEXT NOT NULL PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
      custom_fields TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE user_profiles (
      id TEXT NOT NULL PRIMARY KEY, auth_user_id TEXT, email TEXT NOT NULL, full_name TEXT NOT NULL,
      display_name TEXT, brand TEXT NOT NULL DEFAULT 'OASIS AI', primary_agent TEXT NOT NULL DEFAULT 'bravo',
      agents_enabled TEXT NOT NULL DEFAULT '[]', prospect_focus TEXT NOT NULL DEFAULT '[]',
      mrr_target_usd INTEGER, mrr_current_usd INTEGER, mrr_target_date TEXT, manifesto TEXT,
      tenant_id TEXT, onboarding_completed_at TEXT, team_role TEXT NOT NULL DEFAULT 'member',
      is_owner INTEGER NOT NULL DEFAULT 0, admin_access INTEGER NOT NULL DEFAULT 0, invited_by TEXT,
      deactivated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX user_profiles_auth_user_id_key ON user_profiles (auth_user_id);
    CREATE UNIQUE INDEX user_profiles_email_key ON user_profiles (email);
    CREATE TABLE n8n_webhook_secrets (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      profile_id TEXT NOT NULL, secret_hash TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE pair_attempts (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      profile_id TEXT NOT NULL, outcome TEXT NOT NULL, ip TEXT,
      attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX idx_bridge_pairings_unique_live_machine
      ON bridge_pairings (tenant_id, machine_fingerprint) WHERE revoked_at IS NULL;
    CREATE TABLE agent_model_config (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      encrypted_api_key TEXT, system_prompt_override TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      user_id TEXT, display_name_override TEXT);
    CREATE UNIQUE INDEX idx_agent_model_config_default_per_agent ON agent_model_config (tenant_id, agent_key) WHERE (user_id IS NULL);
    CREATE UNIQUE INDEX idx_agent_model_config_override_per_user ON agent_model_config (tenant_id, user_id, agent_key) WHERE (user_id IS NOT NULL);
  `);
}

let encryptField: (s: string) => string;
let decryptField: (s: string) => string;
let agentKeys: string[] = [];

/** Every check starts from the same database. */
async function seed() {
  for (const t of ["tenants", "user_profiles", "n8n_webhook_secrets", "pair_attempts", "bridge_pairings", "agent_model_config"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  const stamp = (m: number | null) => (m === null ? LONG_AGO : minutesAgo(m));
  for (const id of ALL_TENANTS) {
    const createdAt = stamp(TENANT_AGE_MINUTES[id]);
    await db.execute({
      sql: "INSERT INTO tenants (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, `slug-${id.slice(0, 8)}`, `Workspace ${id.slice(0, 8)}`, createdAt, createdAt],
    });
  }
  for (const p of PEOPLE) {
    const createdAt = stamp(p.createdMinutesAgo);
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, brand, tenant_id,
              onboarding_completed_at, created_at, updated_at, joined_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.profileId, p.authId, p.email, `Name of ${p.email}`, `Brand of ${p.email}`, p.tenant,
        p.onboarded ? createdAt : null, createdAt, createdAt, createdAt],
    });
  }
  for (const [profileId, secret] of [
    [A.profileId, HMAC_A], [B.profileId, HMAC_B], [T.profileId, HMAC_T],
    [C.profileId, HMAC_C], [D.profileId, HMAC_D], [H.profileId, HMAC_H],
  ]) {
    await db.execute({
      sql: "INSERT INTO n8n_webhook_secrets (profile_id, secret_hash) VALUES (?, ?)",
      args: [profileId, sha256(secret)],
    });
  }
  // A is TA's owner (so the existing steeringBody() checks below, which all
  // send api_keys, still seed TA's keys under the O0 admin-required gate).
  await db.execute({ sql: "UPDATE user_profiles SET is_owner = 1, team_role = 'owner' WHERE id = ?", args: [A.profileId] });
  // D was removed from TA 30 minutes ago; its HMAC secret must not survive that.
  await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = ? WHERE id = ?", args: [minutesAgo(30), D.profileId] });
  // X accepted an owner-claim invite — redeem_tenant_invite's shape, not signup_tenant's.
  await db.execute({
    sql: "UPDATE user_profiles SET is_owner = 1, team_role = 'owner', invited_by = ? WHERE id = ?",
    args: ["auth-oasis-operator", X.profileId],
  });
  // Live computers: C's in A's workspace, B's in B's workspace.
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at)
          VALUES ('bp-c', ?, ?, 'C laptop (Windows)', ?, ?, ?)`,
    args: [TA, C.authId, C_TOKEN_HASH, C_FINGERPRINT, LONG_AGO],
  });
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at)
          VALUES ('bp-b', ?, ?, 'B desktop (Mac)', ?, ?, ?)`,
    args: [TB, B.authId, B_TOKEN_HASH, B_FINGERPRINT, LONG_AGO],
  });
  // A live computer in A's workspace whose owner was never recorded.
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at)
          VALUES ('bp-legacy', ?, NULL, 'Shared office PC', ?, ?, ?)`,
    args: [TA, LEGACY_TOKEN_HASH, LEGACY_FINGERPRINT, LONG_AGO],
  });
  // The established workspaces' AI keys, which no other person may overwrite.
  for (const [tenant, key] of [[TA, A_ORIGINAL_KEY], [TB, B_ORIGINAL_KEY]] as const) {
    const cipher = encryptField(key);
    for (const agentKey of agentKeys) {
      await db.execute({
        sql: `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled)
              VALUES (?, NULL, ?, 'openrouter', 'original-model', ?, 1)`,
        args: [tenant, agentKey, cipher],
      });
    }
  }
}

/** Everything a pair call could write for one workspace, as comparable text. */
async function workspaceState(tenant: string): Promise<string> {
  const read = async (sql: string) =>
    (await db.execute({ sql, args: [tenant] })).rows.map((r) => JSON.stringify(r));
  return JSON.stringify({
    tenant: await read("SELECT id, name, custom_fields, updated_at FROM tenants WHERE id = ?"),
    profiles: await read(
      `SELECT id, auth_user_id, email, full_name, display_name, brand, primary_agent, agents_enabled,
              mrr_target_usd, manifesto, onboarding_completed_at, updated_at
       FROM user_profiles WHERE tenant_id = ? ORDER BY id`,
    ),
    keys: await read(
      `SELECT agent_key, user_id, provider, model, encrypted_api_key, enabled, updated_at
       FROM agent_model_config WHERE tenant_id = ? ORDER BY agent_key, user_id`,
    ),
    computers: await read(
      `SELECT id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at, revoked_at
       FROM bridge_pairings WHERE tenant_id = ? ORDER BY id`,
    ),
  });
}

async function livePairings(tenant: string) {
  const r = await db.execute({
    sql: "SELECT id, user_id, label, bridge_token_hash, machine_fingerprint FROM bridge_pairings WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY id",
    args: [tenant],
  });
  return r.rows as unknown as Array<{ id: string; user_id: string | null; label: string; bridge_token_hash: string; machine_fingerprint: string | null }>;
}

async function workspaceKeys(tenant: string): Promise<string[]> {
  const r = await db.execute({
    sql: "SELECT encrypted_api_key FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL ORDER BY agent_key",
    args: [tenant],
  });
  return r.rows.map((row) => decryptField(String(row.encrypted_api_key)));
}

function hmacHeaders(profileId: string, secret: string): Record<string, string> {
  return { "x-oasis-profile-id": profileId, "x-oasis-secret": secret };
}
const SIGNUP_BEARER = { authorization: `Bearer ${SIGNUP_SECRET}` };

function pairRequest(headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest("https://oasisai.work/api/auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** What a wizard or a hostile caller might send to steer the writes. */
function steeringBody(extra: Record<string, unknown>) {
  return {
    profile: { full_name: "Hijacked Name", display_name: "Hijacked", brand: "Hijacked Brand", manifesto: "pwned" },
    api_keys: { openrouter: "sk-or-attacker-key-0001" },
    machine: { label: "Attacker box (Windows)", fingerprint: "attacker-machine-fingerprint-0001" },
    ...extra,
  };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await seed();
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}

async function main() {
  await createSchema();
  ({ encryptField, decryptField } = await import("../lib/field-encryption"));
  agentKeys = (await import("../lib/agent-personas")).chatAgentKeys();
  assert.ok(agentKeys.length > 0, "the seeding test needs at least one chat agent");
  const { POST } = await import("../app/api/auth/pair/route");

  // ── HMAC headers: the proven profile is the person ─────────────────────
  await check("an HMAC caller for A naming B by email pairs A, not B, and writes nothing to B's workspace", async () => {
    const before = await workspaceState(TB);
    const res = await POST(pairRequest(hmacHeaders(A.profileId, HMAC_A), steeringBody({ email: B.email })));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.profile_id, A.profileId, "the proven profile is paired");
    assert.equal(body.tenant_id, TA);
    assert.equal(body.auth_user_id, A.authId);
    assert.equal(await workspaceState(TB), before, "B's profile, AI keys and computers are untouched");
    const ownPairing = (await livePairings(TA)).find((p) => p.bridge_token_hash === sha256(body.bridge.token));
    assert.ok(ownPairing, "the new token's pairing is in A's workspace");
    assert.equal(ownPairing.user_id, A.authId, "and it belongs to A");
    const aProfile = await db.execute({ sql: "SELECT full_name FROM user_profiles WHERE id = ?", args: [A.profileId] });
    assert.equal(aProfile.rows[0].full_name, "Hijacked Name", "the profile fields land on the proven profile");
    assert.deepEqual(
      new Set(await workspaceKeys(TA)),
      new Set(["sk-or-attacker-key-0001"]),
      "the keys sent are seeded into the proven person's own workspace",
    );
  });

  await check("an HMAC caller for A naming B by auth_user_id pairs A", async () => {
    const before = await workspaceState(TB);
    const res = await POST(pairRequest(hmacHeaders(A.profileId, HMAC_A), steeringBody({ auth_user_id: B.authId })));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.profile_id, A.profileId);
    assert.equal(body.tenant_id, TA);
    assert.equal(body.auth_user_id, A.authId);
    assert.equal(await workspaceState(TB), before, "nothing is written to B's workspace");
  });

  await check("an HMAC caller for A naming B by email AND auth_user_id still pairs A", async () => {
    const before = await workspaceState(TB);
    const res = await POST(
      pairRequest(hmacHeaders(A.profileId, HMAC_A), steeringBody({ email: B.email, auth_user_id: B.authId })),
    );
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.profile_id, A.profileId);
    assert.equal(await workspaceState(TB), before);
  });

  await check("the bridge's self-pair body (machine details only) pairs its own profile, and a re-pair rotates its own row", async () => {
    // Exactly what bridge_chat_server.py _self_pair_if_needed sends.
    const selfPair = { machine: { label: "CCPC (Windows)", fingerprint: "5e1f5e1f5e1f5e1f5e1f5e1f5e1f5e1f" } };
    const first = await POST(pairRequest(hmacHeaders(A.profileId, HMAC_A), selfPair));
    const one = await first.json();
    assert.equal(first.status, 200, JSON.stringify(one));
    assert.equal(one.ok, true);
    assert.equal(one.profile_id, A.profileId);
    assert.equal(one.tenant_id, TA);
    assert.match(one.bridge.token, /^oab_[0-9a-f]{64}$/);
    assert.equal(one.seeded.agents, 0, "no keys were sent, none are seeded");
    assert.deepEqual(await workspaceKeys(TA), agentKeys.map(() => A_ORIGINAL_KEY), "the workspace keys are unchanged");

    // The token file went missing: the bridge pairs again from the same machine.
    const second = await POST(pairRequest(hmacHeaders(A.profileId, HMAC_A), selfPair));
    const two = await second.json();
    assert.equal(second.status, 200, JSON.stringify(two));
    assert.equal(two.bridge.pairing_id, one.bridge.pairing_id, "the same row is rotated, not a second one minted");
    assert.notEqual(two.bridge.token, one.bridge.token);
    const mine = (await livePairings(TA)).filter((p) => p.machine_fingerprint === selfPair.machine.fingerprint);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].user_id, A.authId);
    assert.equal(mine[0].bridge_token_hash, sha256(two.bridge.token), "only the newest token works");
  });

  await check("a proven person cannot take over a teammate's live computer by sending its fingerprint", async () => {
    const res = await POST(
      pairRequest(hmacHeaders(A.profileId, HMAC_A), { machine: { label: "Not C", fingerprint: C_FINGERPRINT } }),
    );
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.ok, false);
    assert.match(String(body.error), /^machine_paired_to_another_person\b/);
    assert.ok(JSON.stringify(body).length <= 200, "the wizard prints only the first 200 characters");
    assert.equal(body.bridge, undefined, "no token is handed out");
    const cRow = (await livePairings(TA)).find((p) => p.id === "bp-c");
    assert.ok(cRow, "C's computer is still paired");
    assert.equal(cRow.user_id, C.authId, "and still belongs to C");
    assert.equal(cRow.bridge_token_hash, C_TOKEN_HASH, "C's token still works");
    assert.equal(cRow.label, "C laptop (Windows)");
  });

  await check("a live computer with no recorded owner is refused with its own code, not 'another person'", async () => {
    const res = await POST(
      pairRequest(hmacHeaders(A.profileId, HMAC_A), { machine: { label: "Mine now", fingerprint: LEGACY_FINGERPRINT } }),
    );
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.match(String(body.error), /^machine_pairing_has_no_owner\b/, "there is no person to blame, so the message must not say there is");
    const legacy = (await livePairings(TA)).find((p) => p.id === "bp-legacy");
    assert.ok(legacy);
    assert.equal(legacy.user_id, null, "the row is not claimed");
    assert.equal(legacy.bridge_token_hash, LEGACY_TOKEN_HASH, "its token still works");
  });

  await check("a deactivated member's HMAC secret is refused and writes nothing (profile, keys, pairings)", async () => {
    const before = await workspaceState(TA);
    const res = await POST(
      pairRequest(hmacHeaders(D.profileId, HMAC_D), steeringBody({ machine: { label: "Removed member laptop", fingerprint: "removed-member-fp-00000000000001" } })),
    );
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.match(String(body.error), /^seat_inactive\b/);
    assert.equal(body.bridge, undefined, "no token is handed out");
    assert.equal(await workspaceState(TA), before, "a deactivated member's HMAC pair changes nothing in its own workspace");
  });

  await check("a plain member's HMAC pair with api_keys gets 403 and the workspace keys are unchanged", async () => {
    const res = await POST(
      pairRequest(hmacHeaders(C.profileId, HMAC_C), {
        api_keys: { openrouter: "sk-or-member-c-attempt" },
        machine: { label: "C's second PC", fingerprint: "c-second-fp-000000000000000001" },
      }),
    );
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.match(String(body.error), /^admin_required\b/);
    assert.deepEqual(await workspaceKeys(TA), agentKeys.map(() => A_ORIGINAL_KEY), "the workspace keeps its owner's key, not C's");
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM bridge_pairings WHERE machine_fingerprint = ?", args: ["c-second-fp-000000000000000001"] });
    assert.equal(Number(rows.rows[0].n), 0, "the refused call also mints no computer");
  });

  await check("a plain member's HMAC pair with no api_keys still succeeds (only setting keys needs admin)", async () => {
    const res = await POST(
      pairRequest(hmacHeaders(C.profileId, HMAC_C), { machine: { label: "C's second PC", fingerprint: "c-second-fp-000000000000000002" } }),
    );
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.profile_id, C.profileId);
  });

  await check("an HMAC profile with no sign-in account is refused up front (412), not a 409 'another person' re-pair trap", async () => {
    const fp = "no-sign-in-fp-00000000000000000001";
    const res = await POST(pairRequest(hmacHeaders(H.profileId, HMAC_H), { machine: { label: "No-login box", fingerprint: fp } }));
    const body = await res.json();
    assert.equal(res.status, 412, JSON.stringify(body));
    assert.match(String(body.error), /^profile_has_no_sign_in\b/);
    assert.equal(body.bridge, undefined);
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM bridge_pairings WHERE tenant_id = ? AND machine_fingerprint = ?", args: [TA, fp] });
    assert.equal(Number(rows.rows[0].n), 0, "no unowned row is ever created");

    // Re-pairing (token lost, Bravo's bridge self-pairs again) gets the SAME
    // refusal every time, never the 409 "paired to another person" trap.
    const res2 = await POST(pairRequest(hmacHeaders(H.profileId, HMAC_H), { machine: { label: "No-login box", fingerprint: fp } }));
    assert.equal(res2.status, 412, JSON.stringify(await res2.json()));
  });

  await check("the signup secret cannot pair an owner-claim invite accepted minutes ago into an operator-provisioned workspace", async () => {
    const res = await POST(
      pairRequest(SIGNUP_BEARER, steeringBody({ email: X.email, machine: { label: "Another client's PC", fingerprint: "other-client-fp-00000000000001" } })),
    );
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.match(String(body.error), /^use_a_pair_code\b/);
    assert.equal(body.bridge, undefined);
    assert.deepEqual(await workspaceKeys(TX), [], "no attacker key lands in the just-provisioned client workspace");
    const pairings = await db.execute({ sql: "SELECT count(*) AS n FROM bridge_pairings WHERE tenant_id = ?", args: [TX] });
    assert.equal(Number(pairings.rows[0].n), 0);
  });

  await check("a proven profile with no workspace is refused (412) before its profile is written", async () => {
    const before = await db.execute({ sql: "SELECT full_name, brand, manifesto FROM user_profiles WHERE id = ?", args: [T.profileId] });
    const res = await POST(pairRequest(hmacHeaders(T.profileId, HMAC_T), steeringBody({})));
    assert.equal(res.status, 412);
    const after = await db.execute({ sql: "SELECT full_name, brand, manifesto FROM user_profiles WHERE id = ?", args: [T.profileId] });
    assert.deepEqual(after.rows, before.rows, "a refused pair changes nothing");
    const pairings = await db.execute({ sql: "SELECT count(*) AS n FROM bridge_pairings WHERE user_id = ?", args: [T.authId] });
    assert.equal(Number(pairings.rows[0].n), 0);
  });

  await check("a wrong HMAC secret with no signup secret is refused before anything is read or written", async () => {
    const before = await workspaceState(TA);
    const res = await POST(pairRequest(hmacHeaders(A.profileId, "not-the-secret"), steeringBody({ email: A.email })));
    assert.equal(res.status, 401);
    assert.equal(await workspaceState(TA), before);
  });

  // ── CLI_SIGNUP_SECRET: only an account still being set up ──────────────
  for (const [label, who] of [
    ["an onboarded account", A],
    ["an account in another workspace (B)", B],
    ["an account provisioned 65 minutes ago that never onboarded", O],
    ["a member invited minutes ago into an established workspace", M],
    ["a two-hour-old profile attached to a workspace created minutes ago", P],
    ["an account created minutes ago that already finished onboarding", Q],
  ] as const) {
    await check(`the signup secret naming ${label} gets 403 use_a_pair_code, and nothing is written`, async () => {
      const before = await Promise.all(ALL_TENANTS.map(workspaceState));
      const res = await POST(pairRequest(SIGNUP_BEARER, steeringBody({ email: who.email })));
      const body = await res.json();
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(body.ok, false);
      assert.match(String(body.error), /^use_a_pair_code\b/);
      assert.ok(String(body.error).includes("Settings > Devices"), "the refusal says where to get a pair code");
      assert.equal(body.bridge, undefined, "no token is handed out");
      assert.deepEqual(await Promise.all(ALL_TENANTS.map(workspaceState)), before, "no workspace changed");
    });
  }

  await check("the refusal fits in what the wizard prints (the first 200 characters of the body)", async () => {
    const res = await POST(pairRequest(SIGNUP_BEARER, { email: A.email }));
    const text = await res.text();
    assert.equal(res.status, 403);
    assert.ok(text.length <= 200, `${text.length} characters: ${text}`);
  });

  await check("the signup secret naming an established account by auth_user_id is refused the same way", async () => {
    const before = await workspaceState(TB);
    const res = await POST(pairRequest(SIGNUP_BEARER, steeringBody({ email: N.email, auth_user_id: B.authId })));
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.match(String(body.error), /^use_a_pair_code\b/);
    assert.equal(await workspaceState(TB), before);
  });

  await check("api_keys sent with the signup secret never seed an established workspace's AI keys", async () => {
    const res = await POST(
      pairRequest(SIGNUP_BEARER, { email: B.email, api_keys: { anthropic: "sk-ant-attacker", openrouter: "sk-or-attacker" } }),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await workspaceKeys(TB), agentKeys.map(() => B_ORIGINAL_KEY), "B's workspace keeps its own key");
    const anyAttacker = await db.execute(
      "SELECT count(*) AS n FROM agent_model_config WHERE model <> 'original-model' OR user_id IS NOT NULL",
    );
    assert.equal(Number(anyAttacker.rows[0].n), 0, "no key row was added anywhere");
  });

  await check("the signup secret for a just-provisioned account pairs as before", async () => {
    const otherTenants = ALL_TENANTS.filter((t) => t !== TN);
    const others = await Promise.all(otherTenants.map(workspaceState));
    const res = await POST(
      pairRequest(SIGNUP_BEARER, {
        email: N.email,
        profile: { full_name: "New Operator", brand: "New Co" },
        api_keys: { openrouter: "sk-or-new-operator-key" },
        machine: { label: "Windows - NEWPC", fingerprint: "Windows|AMD64|NEWPC" },
      }),
    );
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.profile_id, N.profileId);
    assert.equal(body.tenant_id, TN);
    assert.equal(body.auth_user_id, N.authId);
    assert.match(body.bridge.token, /^oab_[0-9a-f]{64}$/);
    const live = await livePairings(TN);
    assert.equal(live.length, 1);
    assert.equal(live[0].user_id, N.authId);
    assert.equal(live[0].bridge_token_hash, sha256(body.bridge.token));
    const profile = await db.execute({ sql: "SELECT full_name, brand FROM user_profiles WHERE id = ?", args: [N.profileId] });
    assert.equal(profile.rows[0].full_name, "New Operator");
    assert.equal(profile.rows[0].brand, "New Co");
    assert.equal(body.seeded.agents, agentKeys.length);
    assert.equal(body.seeded.provider, "openrouter");
    assert.deepEqual(await workspaceKeys(TN), agentKeys.map(() => "sk-or-new-operator-key"), "keys land in its own new workspace");
    assert.deepEqual(await Promise.all(otherTenants.map(workspaceState)), others, "no other workspace changed");
  });

  if (failures) {
    console.error(`pair-identity-binding: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("pair-identity-binding: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
