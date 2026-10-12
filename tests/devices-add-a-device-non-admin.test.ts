/**
 * devices-add-a-device-non-admin.test.ts - D0: the Devices section had no
 * way to add a computer at all (ConnectYourComputerCard lived only on
 * Profile). Fix: the SAME card, reused not forked, at the TOP of the
 * Devices section, gated on `show("devices")` alone. Every member also sees
 * their own computers; only the raw team/advanced inventory remains operator-
 * only.
 *
 * This exercises the real /settings/devices page guard and then renders the
 * SettingsContent it returns. A component-only test previously passed while
 * the actual page still 404ed members.
 *
 * Both personas are real rows read through the real Turso adapter and the
 * real session cookie: a workspace owner and a plain member. Neither is a
 * verified platform operator (ADMIN_EMAILS is empty, OPERATOR_EMAIL is
 * unset), but both can manage their own computers. Only the raw team-wide
 * "Devices (advanced)" inventory stays operator-only.
 *
 * Run: node --conditions=react-server --import tsx tests/devices-add-a-device-non-admin.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "devices-add-a-device-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "devices-add-a-device-test-secret-long-enough-01";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

// tsconfig sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React (same stand-in every other
// react-server test in this suite uses).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
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
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
function stubFile(rel: string, exports: Record<string, unknown>) {
  const p = join(__dirname, "..", rel);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
// A class component (React.Component is not exported under react-server). A
// pass-through keeps its children in the tree the walker below reads.
stubFile("components/SafeBoundary.tsx", {
  SafeBoundary: ({ children }: { children?: unknown }) => children,
});

const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006c";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  client: u(1, "owner@devices-test.client"), // owner of the client workspace -- canManageTenant true
  member: u(2, "riley@devices-test.client"), // plain member -- canManageTenant false
} as const;
type Who = keyof typeof USERS;

async function login(who: Who): Promise<void> {
  const { signSession } = await import("../lib/turso-auth");
  const user = USERS[who];
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

/** Every string and every element in a returned (unrendered) React tree. */
type Found = { strings: string[]; elements: Array<{ type: unknown; props: Record<string, unknown> }> };
function walk(node: unknown, out: Found = { strings: [], elements: [] }, seen = new Set<unknown>()): Found {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.strings.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    out.elements.push({ type: el.type, props: el.props });
    walk(el.props, out, seen);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) walk(v, out, seen);
  return out;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  const raw = createClient({ url: `file:${dbFile}` });
  // Trimmed to exactly what SettingsContent's unconditional reads touch for
  // ANY section (profile, tenant, isVerifiedOperator, isAgentsOwner) plus
  // the devices section's own ConnectYourComputerCard mount, which is a
  // client component SettingsContent only places in the tree -- it is never
  // actually mounted/fetched from here (no react-dom, no browser).
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT, invited_by TEXT, joined_at TEXT,
      manager_user_id TEXT, deactivated_by TEXT, deactivation_reason TEXT, brand TEXT, manifesto TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, logo_url TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, last_seen_at TEXT,
      tool_capabilities TEXT, revoked_at TEXT);
    CREATE TABLE workspace_agents_owner (id TEXT PRIMARY KEY, tenant_id TEXT, auth_user_id TEXT,
      created_at TEXT, revoked_at TEXT);
  `);

  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const clientManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "oasis-ai-cc", answers: {} }));

  const stamp = "2026-10-12T00:00:00Z";
  const profile = (who: Who, role: string, owner: 0 | 1, name: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, full_name, display_name, agents_enabled, updated_at, joined_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '["bravo"]', ?, ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, CLIENT, role, owner, stamp, name, name, stamp, stamp],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI Solutions')", args: [CLIENT] },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client', ?, 'oasis-ai-cc', ?, 1, 1, ?, ?)",
        args: [CLIENT, JSON.stringify(clientManifest), stamp, stamp],
      },
      profile("client", "owner", 1, "Alex Owner"),
      profile("member", "member", 0, "Riley"),
    ],
    "write",
  );

  const { SettingsContent } = await import("../components/settings/SettingsContent");
  const { ConnectYourComputerCard } = await import("../components/settings/YourComputersCard");
  const settingsDevicesPage = (await import("../app/settings/devices/page")).default;

  /**
   * The page guard resolves a real viewerAccess. We then render its captured
   * SettingsContent props so this bare-node test can inspect the server tree.
   */
  async function devicesTreeFor(who: Who): Promise<unknown> {
    await login(who);
    const page = await settingsDevicesPage();
    const el = walk(page).elements.find((e) => e.type === SettingsContent);
    assert.ok(el, "/settings/devices mounts SettingsContent");
    const props = el!.props as Parameters<typeof SettingsContent>[0];
    return SettingsContent(props);
  }

  console.log("devices-add-a-device-non-admin:");

  await check("a plain OASIS member reaches the real Devices page and sees Add a device", async () => {
    const tree = await devicesTreeFor("member");
    const found = walk(tree);
    assert.ok(found.elements.some((e) => e.type === ConnectYourComputerCard), "ConnectYourComputerCard is not in a non-admin member's Devices tree");
    assert.ok(found.strings.includes("Add a device"), 'the "Add a device" title is not in a non-admin member\'s Devices tree');
  });

  await check("that same non-admin member sees their own computers but never Devices (advanced)", async () => {
    const tree = await devicesTreeFor("member");
    const ids = walk(tree)
      .elements.map((e) => e.props.id)
      .filter((id): id is string => typeof id === "string");
    assert.ok(ids.includes("your-computers"), "a non-admin member cannot manage their own computers");
    assert.ok(!ids.includes("devices"), "a non-admin member can see Devices (advanced), the raw pair/revoke list");
    assert.ok(ids.includes("add-a-device"), "the add-a-device section id is missing");
    const card = readFileSync(join(__dirname, "..", "components/settings/YourComputersCard.tsx"), "utf8");
    assert.match(card, />\s*Disconnect\s*</);
    assert.ok(card.includes('fetch(`/api/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" })'));
  });

  await check("the workspace owner also sees Add a device at the top, using the same card", async () => {
    const tree = await devicesTreeFor("client");
    const found = walk(tree);
    assert.ok(found.elements.some((e) => e.type === ConnectYourComputerCard), "ConnectYourComputerCard is not in the owner's Devices tree");
    assert.ok(found.strings.includes("Add a device"));
    // Neither viewer is a verified platform operator. Both still manage their
    // own computers; only the raw advanced surface stays absent.
    const ids = walk(tree)
      .elements.map((e) => e.props.id)
      .filter((id): id is string => typeof id === "string");
    assert.ok(ids.includes("your-computers"));
    assert.ok(!ids.includes("devices"));
  });

  if (failures) {
    console.error(`devices-add-a-device-non-admin: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("devices-add-a-device-non-admin: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
