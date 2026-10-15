/**
 * tests/device-rename.test.ts - a person can rename their own computer (2026-10-15).
 *
 * A Mac with no hostname set reports the router's DHCP address as its name, so CC's
 * pairing read "192.168.11.27 (Mac)" with no way to change it. PATCH /api/devices
 * renames ONE OF YOUR computers. What this pins:
 *
 *   1. the name rules (one printable line, trimmed, non-empty, short);
 *   2. only the OWNER may rename: not a teammate, and not an admin either;
 *   3. tenant-scoped on the read AND the write: another workspace's id is a 404;
 *   4. a cross-origin request is refused, a revoked pairing cannot be renamed;
 *   5. the machine fingerprint and every other column are left alone (a rename
 *      must not make the computer pair again);
 *   6. the card wires a Rename control to it and explains "signed in".
 *
 * Run: node --conditions=react-server --import tsx tests/device-rename.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "device-rename-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "device-rename-test-secret-long-enough-0001";
process.env.EMPIRE_AUTH_BACKEND = "turso";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "BRAVO_DASHBOARD_URL"]) {
  delete process.env[k];
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
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

const db: Client = createClient({ url: `file:${dbFile}` });
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const TENANT = "d3d3d3d3-0000-4000-8000-0000000000d3";
const OTHER_TENANT = "e4e4e4e4-0000-4000-8000-0000000000e4";
const CC = "auth-cc-0001"; // an owner-role seat; owns the Mac
const ADON = "auth-adon-0001"; // a plain member; owns the Windows PC
const stamp = "2026-10-15T00:00:00.000Z";

async function seed() {
  await db.executeMultiple(`
    DROP TABLE IF EXISTS tenants; DROP TABLE IF EXISTS "_supabase_auth_users";
    DROP TABLE IF EXISTS user_profiles; DROP TABLE IF EXISTS bridge_pairings;
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL,
      bridge_token_hash TEXT NOT NULL, machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT,
      scope TEXT, paired_via TEXT, claim_enabled_at TEXT);
  `);
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI Solutions')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'other-co', 'Other Co')", args: [OTHER_TENANT] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, 'cc@oasisai.work')`, args: [CC] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, 'adon@oasisai.work')`, args: [ADON] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-cc', ?, 'cc@oasisai.work', ?, 'owner', 1, 'CC', ?, ?)`,
        args: [CC, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-adon', ?, 'adon@oasisai.work', ?, 'member', 0, 'Adon', ?, ?)`,
        args: [ADON, TENANT, stamp, stamp],
      },
      ...[
        ["mac", CC, "192.168.11.27 (Mac)", TENANT, null],
        ["pc", ADON, "UPPAECHELON (Windows)", TENANT, null],
        ["old", CC, "Retired laptop", TENANT, stamp],
        ["elsewhere", CC, "Not in this workspace", OTHER_TENANT, null],
      ].map(([id, userId, label, tenant, revokedAt]) => ({
        sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, revoked_at, scope, paired_via)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'connector', 'connector_code')`,
        args: [id as string, tenant as string, userId as string, label as string, sha256(`token-${id}`), `fp-${id}`, revokedAt as string | null],
      })),
    ],
    "write",
  );
}

async function login(authUserId: string, email: string) {
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: authUserId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

async function labelOf(id: string): Promise<string> {
  return String((await db.execute({ sql: "SELECT label FROM bridge_pairings WHERE id = ?", args: [id] })).rows[0].label);
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await seed();
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  const { deviceLabelProblem, deviceLabelProblemWords, DEVICE_LABEL_MAX } = await import("../lib/devices/label");
  const devicesRoute = await import("../app/api/devices/route");

  const patch = async (body: unknown, headers: Record<string, string> = { origin: "https://oasisai.work", host: "oasisai.work" }) => {
    const res = await devicesRoute.PATCH(
      new NextRequest("https://oasisai.work/api/devices", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  console.log("device-rename:");

  await check("the name rules: one printable line, trimmed, non-empty, short", () => {
    assert.equal(deviceLabelProblem("CC's MacBook"), null);
    assert.equal(deviceLabelProblem("  Studio Mac  "), null, "surrounding spaces are trimmed, not refused");
    assert.equal(deviceLabelProblem("x".repeat(DEVICE_LABEL_MAX)), null);
    assert.equal(deviceLabelProblem("x".repeat(DEVICE_LABEL_MAX + 1)), "label_too_long");
    for (const empty of ["", "   ", "\t", undefined, null, 42]) assert.equal(deviceLabelProblem(empty), "label_required", String(empty));
    // Built from code points: this file is written through a tool that decodes
    // backslash-u escapes into raw characters, which would put a literal NUL and a
    // literal line separator inside these strings.
    const ch = (...codes: number[]) => String.fromCharCode(...codes);
    for (const bad of ["two" + ch(10) + "lines", "tab" + ch(9) + "here", "nul" + ch(0) + "byte", "line" + ch(0x2028) + "sep", "bell" + ch(7)]) {
      assert.equal(deviceLabelProblem(bad), "label_invalid", JSON.stringify(bad));
    }
    assert.match(deviceLabelProblemWords("label_too_long"), /60 characters/);
    assert.match(deviceLabelProblemWords("something_else"), /Could not rename/, "an unknown code still reads as a sentence");
  });

  await check("the owner renames their own computer; nothing else on the row changes", async () => {
    await login(CC, "cc@oasisai.work");
    const before = (await db.execute("SELECT * FROM bridge_pairings WHERE id = 'mac'")).rows[0];
    const r = await patch({ id: "mac", label: "  CC's MacBook  " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, label: "CC's MacBook" }, "the trimmed name comes back");
    const after = (await db.execute("SELECT * FROM bridge_pairings WHERE id = 'mac'")).rows[0];
    assert.equal(after.label, "CC's MacBook");
    for (const column of ["tenant_id", "user_id", "bridge_token_hash", "machine_fingerprint", "revoked_at", "scope", "paired_via"]) {
      assert.equal(after[column], before[column], `${column} must not change: a rename never makes a computer pair again`);
    }
  });

  await check("a teammate cannot rename it, and an admin cannot rename a teammate's computer either", async () => {
    await login(ADON, "adon@oasisai.work");
    const r = await patch({ id: "mac", label: "Not yours" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_your_computer");
    assert.equal(await labelOf("mac"), "192.168.11.27 (Mac)");
    // CC is the owner-role seat (admin) and still may not rename Adon's PC.
    await login(CC, "cc@oasisai.work");
    const admin = await patch({ id: "pc", label: "CC renamed Adon's PC" });
    assert.equal(admin.status, 403);
    assert.equal(await labelOf("pc"), "UPPAECHELON (Windows)");
  });

  await check("another workspace's pairing is a 404 even for the same person, and signed out is a 401", async () => {
    await login(CC, "cc@oasisai.work");
    const r = await patch({ id: "elsewhere", label: "Cross-workspace" });
    assert.equal(r.status, 404, "the lookup is scoped to the session's workspace");
    assert.equal(await labelOf("elsewhere"), "Not in this workspace");
    sessionCookie = undefined;
    assert.equal((await patch({ id: "mac", label: "Anonymous" })).status, 401);
    assert.equal(await labelOf("mac"), "192.168.11.27 (Mac)");
  });

  await check("a revoked pairing cannot be renamed; bad input is refused before any write", async () => {
    await login(CC, "cc@oasisai.work");
    const revoked = await patch({ id: "old", label: "Back from the dead" });
    assert.equal(revoked.status, 409);
    assert.equal(revoked.body.error, "pairing_revoked");
    assert.equal(await labelOf("old"), "Retired laptop");
    for (const [body, error] of [
      [{ id: "mac", label: "" }, "label_required"],
      [{ id: "mac", label: "y".repeat(61) }, "label_too_long"],
      [{ id: "mac", label: "a\nb" }, "label_invalid"],
      [{ label: "no id" }, "id required"],
    ] as const) {
      const r = await patch(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error);
    }
    assert.equal((await patch("{not json")).status, 400);
    assert.equal(await labelOf("mac"), "192.168.11.27 (Mac)", "nothing was written");
  });

  await check("a cross-origin request is refused, same-origin via Referer is accepted", async () => {
    await login(CC, "cc@oasisai.work");
    const evil = await patch({ id: "mac", label: "Hijacked" }, { origin: "https://evil.example", host: "oasisai.work" });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, "cross_origin_refused");
    const noOrigin = await patch({ id: "mac", label: "No origin" }, { host: "oasisai.work" });
    assert.equal(noOrigin.status, 403, "no Origin or Referer at all is refused too");
    assert.equal(await labelOf("mac"), "192.168.11.27 (Mac)");
    const viaReferer = await patch({ id: "mac", label: "Via referer" }, { referer: "https://oasisai.work/settings/devices", host: "oasisai.work" });
    assert.equal(viaReferer.status, 200);
  });

  await check("the route exports only handlers and config (a route module may export nothing else)", () => {
    const src = readFileSync(join(__dirname, "..", "app", "api", "devices", "route.ts"), "utf8");
    const exports = [...src.matchAll(/^export (?:async )?(?:function|const|let|class|type|interface) (\w+)/gm)].map((m) => m[1]);
    for (const name of exports) {
      assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE", "dynamic", "runtime"].includes(name), `route.ts exports ${name}`);
    }
    assert.ok(exports.includes("PATCH"));
  });

  await check("the card wires Rename to it and says what \"signed in\" means", () => {
    const card = readFileSync(join(__dirname, "..", "components", "settings", "YourComputersCard.tsx"), "utf8");
    assert.match(card, /method: "PATCH"/);
    assert.match(card, /deviceLabelProblem\(value\)/, "the same rules run in the browser before the request");
    assert.match(card, /maxLength=\{DEVICE_LABEL_MAX\}/);
    assert.match(card, />\s*Rename\s*</);
    assert.match(card, /data-testid="signed-in-caption"/);
    assert.match(card, /confirmed by a Test in Settings &gt; AI brain/);
    // Not renameable from the TEAM list (a teammate's computer): Rename sits in the owner's own rows only.
    const teamBlock = card.slice(card.indexOf('summary className="cursor-pointer'), card.indexOf("</details>"));
    assert.doesNotMatch(teamBlock, /Rename/, "no Rename on a teammate's computer");
    assert.match(teamBlock, /\$\{ownerName\}|\{ownerName\}&apos;s computer/, "every team row says whose computer it is");
  });

  if (failures) {
    console.error(`device-rename: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("device-rename: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
