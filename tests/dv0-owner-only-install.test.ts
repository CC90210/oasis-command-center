/**
 * tests/dv0-owner-only-install.test.ts — DV0 (2026-10-11): Settings > Devices
 * tells the truth about who the full-install path is for.
 *
 * THE INCIDENT. Adon (co-owner, admin seat, verified platform operator) clicked
 * Devices > "Connect this computer" > "New computer: full install" and ran the
 * shown one-liner. It failed: `gh api repos/CC90210/CEO-Agent/contents/install.ps1`
 * is a 404 for every GitHub account but CC's, because the harness repo is
 * private to CC. Since PR #576 every OASIS founder is a verified operator, so
 * "operator" alone was never the right gate for a command that only works on
 * one person's machine with one person's GitHub account.
 *
 * WHAT IS PINNED, against the real page (`/settings/devices/install`) and the
 * real `installOneLiner`, with a live local libSQL file and the real
 * `platform_operators` / `workspace_agents_owner` migrations (the same shape
 * tests/bridge-owner-gate.test.ts uses for the same CC/Adon split):
 *   - CC (this workspace's AGENTS OWNER, lib/agents-owner.ts, O1): the full
 *     install wizard mounts, with the repo passed in.
 *   - Adon (verified operator, NOT the owner): no wizard, no private-repo
 *     name anywhere in the render, and the honest notice instead — not the
 *     generic pair-only flow, which cannot reach anywhere for him either
 *     (O1 routes every department chat to the owner's computer alone).
 *   - An ordinary client workspace owner (not an operator, no owner row on
 *     their own tenant): UNCHANGED — still the working pair-only flow, so
 *     DV0 does not regress the one install path that already works for a
 *     real client.
 *   - The hardened one-liner (lib/bridge-install-command.ts): on every OS, an
 *     empty `gh api` download is refused with one plain sentence before any
 *     base64 decode or shell run — never iex/bash on empty input.
 *
 * Run: node --conditions=react-server --import tsx tests/dv0-owner-only-install.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { isValidElement } from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "dv0-owner-only-install-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "dv0-owner-only-install-secret-long-enough-00001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
// Adon's operator status must come from the P0-7 table (platform_operators),
// never an env alias — that is the realistic scenario this test exists for.
delete process.env.ADMIN_EMAILS;

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});

const CLIENT_TENANT = "9d9d9d9d-0000-4000-8000-00000000009d";
const u = (n: number, email: string) => ({ id: `0d000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const CC = u(1, "conaugh@oasisai.work"); // alias operator, OASIS owner, owns the computer
const ADON = u(2, "adon@oasisai.work"); // listed operator (platform_operators), admin seat, NOT the computer's owner
const CLIENT_OWNER = u(3, "owner@dv0-client.test"); // ordinary client workspace owner: not an operator, no owner-row lock

async function login(user: { id: string; email: string } | null) {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

/**
 * Client components that use hooks. There is no React dispatcher under
 * react-server, so the walkers below never call one: they record its string
 * props (textOf) or the element itself (elementsOf) instead. Copied from
 * tests/f0-containment.test.ts, which proves this technique against the same
 * page component.
 */
const OPAQUE = new Set<unknown>();

function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 60 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function" && !OPAQUE.has(node.type)) {
      const rendered = (node.type as (p: unknown) => unknown)(props);
      textOf(rendered, out, depth + 1);
      return out;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v, out, depth + 1);
      else if (typeof v === "string") out.push(v);
    }
    return out;
  }
  return out;
}

function elementsOf(node: unknown, type: unknown, out: ReactNS.ReactElement[] = [], depth = 0): ReactNS.ReactElement[] {
  if (depth > 60 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n, type, out, depth + 1);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) {
    out.push(node);
    return out;
  }
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (typeof node.type === "function" && !OPAQUE.has(node.type)) {
    return elementsOf((node.type as (p: unknown) => unknown)(props), type, out, depth + 1);
  }
  return elementsOf(props.children, type, out, depth + 1);
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  const stamp = "2026-10-11T00:00:00Z";
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
  `);
  // The real migrations, exactly as tests/bridge-owner-gate.test.ts runs them
  // for the same CC/Adon split.
  for (const file of ["database/turso/bravo__208_platform_operators.sql", "database/turso/bravo__210_workspace_agents_owner.sql"]) {
    await db.executeMultiple(readFileSync(join(ROOT, file), "utf8"));
  }
  const { OASIS_OPERATOR_TENANT_ID } = await import("../lib/platform-operator");
  const OASIS = OASIS_OPERATOR_TENANT_ID;
  const profile = (user: { id: string; email: string }, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, primary_agent, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["bravo"]', 'bravo', ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...[CC, ADON, CLIENT_OWNER].map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', '{}')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'dv0-client-co', 'DV0 Client Co', '{}')", args: [CLIENT_TENANT] },
      profile(CC, OASIS, "owner", 1),
      profile(ADON, OASIS, "admin", 0),
      profile(CLIENT_OWNER, CLIENT_TENANT, "owner", 1),
      // Adon: listed operator (P0-7), never revoked.
      { sql: "INSERT INTO platform_operators (auth_user_id, added_by, added_at, note, revoked_at) VALUES (?, 'test', ?, 'fixture', NULL)", args: [ADON.id, stamp] },
      // CC: the workspace's agents owner (hand-inserted, as production is).
      { sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at, note, revoked_at) VALUES (?, ?, 'test', ?, 'fixture', NULL)", args: [OASIS, CC.id, stamp] },
    ],
    "write",
  );

  console.log("dv0-owner-only-install:");

  const bridgeInstallPage = (await import("../app/settings/devices/install/page")).default;
  const { InstallBridgeWizard } = await import("../app/settings/devices/install/InstallBridgeWizard");
  const { PairBridgeOnly } = await import("../app/settings/devices/install/PairBridgeOnly");
  const { HARNESS_REPO } = await import("../lib/install-scripts");
  const { installOneLiner } = await import("../lib/bridge-install-command");
  OPAQUE.add(InstallBridgeWizard);
  OPAQUE.add(PairBridgeOnly);

  const HARNESS_LEAKS = ["CEO-Agent", "CC90210", "gh api", "gh auth", "raw.githubusercontent"];

  // ── 1. The real page, three viewers ─────────────────────────────────────
  await check("the owner (CC): the full install wizard mounts, with the repo passed in", async () => {
    await login(CC);
    const tree = await bridgeInstallPage();
    const wizards = elementsOf(tree, InstallBridgeWizard);
    assert.equal(wizards.length, 1, "CC must get the full wizard");
    assert.equal((wizards[0].props as { installRepo?: unknown }).installRepo, HARNESS_REPO);
    assert.deepEqual(elementsOf(tree, PairBridgeOnly), [], "the owner's own wizard carries its own pair-only mode");
  });

  await check("a non-owner verified operator (Adon): no full-install command, no private-repo name, no pair-only dead end", async () => {
    await login(ADON);
    const tree = await bridgeInstallPage();
    assert.deepEqual(elementsOf(tree, InstallBridgeWizard), [], "Adon must not get the full wizard");
    // Pair-only cannot reach anywhere for Adon either: O1 routes every
    // department chat to the owner's computer alone, so it would be a dead
    // end dressed as a working feature.
    assert.deepEqual(elementsOf(tree, PairBridgeOnly), [], "Adon must not get the generic pair-only flow on this workspace");
    const page = textOf(tree).join("\n");
    assert.match(page, /Connecting your own computer/);
    assert.match(page, /OASIS connector/);
    // D0, 2026-10-12: "there is nothing to install today" was itself false
    // — the connector already runs on OASIS's own team computers. This now
    // pins the honest replacement copy instead of the line it used to prove
    // existed.
    assert.match(page, /runs today on OASIS's own team computers/);
    assert.match(page, /one-click installer/i);
    assert.doesNotMatch(page, /nothing to\s*\n?\s*install today/);
    assert.match(page, /pause/i);
    for (const leak of HARNESS_LEAKS) assert.ok(!page.includes(leak), `"${leak}" shown to a non-owner operator`);
  });

  await check("an ordinary client workspace owner: unchanged, keeps the pair-only flow that already works for them", async () => {
    await login(CLIENT_OWNER);
    const tree = await bridgeInstallPage();
    assert.deepEqual(elementsOf(tree, InstallBridgeWizard), [], "a client never gets the full wizard");
    assert.equal(elementsOf(tree, PairBridgeOnly).length, 1, "a client keeps the working pair-only flow (no owner-row lock on their own tenant)");
    const page = textOf(tree).join("\n");
    assert.match(page, /private beta/i);
    for (const leak of HARNESS_LEAKS) assert.ok(!page.includes(leak), `"${leak}" shown to a client`);
  });

  // ── 2. Mutation check: CC and Adon must render DIFFERENTLY ──────────────
  // Not a stand-in for the two checks above — a direct proof that the owner
  // gate, not some unrelated difference between the fixtures, is what moves
  // the wizard. If a future edit makes both viewers resolve the same way,
  // this fails even if the two checks above were each individually weakened.
  await check("mutation check: CC and Adon do not render the same install surface", async () => {
    await login(CC);
    const ccWizards = elementsOf(await bridgeInstallPage(), InstallBridgeWizard).length;
    await login(ADON);
    const adonWizards = elementsOf(await bridgeInstallPage(), InstallBridgeWizard).length;
    assert.notEqual(ccWizards, adonWizards, "the owner gate must distinguish CC from Adon");
    assert.equal(ccWizards, 1);
    assert.equal(adonWizards, 0);
  });

  // ── 3. The hardened one-liner, all three OSes ───────────────────────────
  const PAIR_CODE = "ABC-DEF-GHJ";
  await check("the hardened one-liner refuses an empty download, on every OS, before any decode or run", () => {
    for (const os of ["windows", "macos", "linux"] as const) {
      const cmd = installOneLiner(os, PAIR_CODE, HARNESS_REPO);
      assert.ok(cmd.includes("Could not download the installer"), `${os}: missing the plain failure sentence`);
      assert.ok(cmd.includes("gh auth login"), `${os}: missing the fix`);
      const guardAt = cmd.indexOf("Could not download the installer");
      const decodeAt = os === "windows" ? cmd.indexOf("FromBase64String") : cmd.indexOf('bash -c "$s"');
      assert.ok(guardAt >= 0 && decodeAt >= 0, `${os}: guard or decode/run step missing`);
      assert.ok(guardAt < decodeAt, `${os}: the guard must come before the decode/run step`);
      // Existing pinned shape (tests/f0-containment.test.ts "the operator's
      // full-install command reads the private repo through gh"): gh api, the
      // repo path, the pair code, never an anonymous raw URL. Hardening must
      // not have dropped any of it.
      const file = os === "windows" ? "install.ps1" : "install.sh";
      assert.ok(cmd.includes("gh api") && cmd.includes(`repos/${HARNESS_REPO}/contents/${file}`), `${os}: lost the gh api call`);
      assert.ok(cmd.includes("BRAVO_PAIR_CODE") && cmd.includes(PAIR_CODE), `${os}: lost the pair code`);
      assert.ok(!cmd.includes("raw.githubusercontent"), `${os}: an anonymous raw URL is a 404 on a private repo`);
    }
  });
  await check("the hardened one-liner never pipes an unguarded download into base64/iex/bash", () => {
    for (const os of ["windows", "macos", "linux"] as const) {
      const cmd = installOneLiner(os, PAIR_CODE, HARNESS_REPO);
      // The raw `gh api ... | bash` pipe and the un-variabled `-join ''` into
      // FromBase64String are exactly what let an empty download reach a
      // decode/run step; the hardened shape always captures into a variable
      // first and only acts on it inside the guarded branch.
      assert.ok(!/\|\s*(?:\$\{?\w+\}?=\S+\s+)?bash\s*$/.test(cmd.trim()), `${os}: still pipes gh api straight into bash unguarded`);
    }
  });

  if (failures > 0) {
    console.log(`dv0-owner-only-install: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("dv0-owner-only-install: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
