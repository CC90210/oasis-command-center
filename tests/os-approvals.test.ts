/**
 * os-approvals.test.ts — the approvals backbone ("Needs you") end to end.
 *
 * WHY THIS EXISTS. An approval is the ONE gate between an AI teammate's draft
 * and something that leaves the business. The failures that matter are all
 * invisible until a real email goes to the wrong person:
 *   - a "yes" landing on words the approver never saw (payload-hash binding);
 *   - one click, two emails (exactly-once under concurrent approve/execute);
 *   - a kind with no send path reporting success (unknown kind fails loudly);
 *   - a send-back with no note, which gives the agent nothing to revise;
 *   - workspace B reading, deciding or executing workspace A's approvals;
 *   - a sales rep deciding Marketing's or Finance's approvals;
 *   - an agent tool that sends instead of proposing.
 * Each is driven here against REAL libSQL (a temp file with migration
 * bravo__186 applied the way scripts/apply_turso_migration.py splits it), the
 * real signed session, the real routes and the real executors — only the
 * mailbox is a fake where a live send is exercised, and next/headers +
 * next/navigation are stood in, as in tests/goals-route-persona.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/os-approvals.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "os-approvals-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "os-approvals-test-secret-that-is-long-enough-000001";
// Dry-run is the deployment default; nothing in this file may be able to send.
for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "BRAVO_FORCE_DRY_RUN", "OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD"]) {
  delete process.env[k];
}

// A configured credential, set before anything snapshots the env for redaction
// (lib/secret-redaction.ts caches the pairs on first use). list_proposals must
// never hand it to a model, whoever typed it into a note.
const CANARY_SECRET = "sk-approvals-canary-7f3e9d2c1b0a5566";
process.env.OS_APPROVALS_CANARY_API_KEY = CANARY_SECRET;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // slug oasis-ai-cc
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b"; // slug client-co
process.env.FOUNDERS_TENANT_IDS = OASIS;

// tsx compiles the components with the classic JSX runtime.
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
  useRouter: () => {
    throw new Error("client hook called under react-server");
  },
});
// The department composer context calls createContext at import time, which
// react-server does not have. The Overview panel only needs it as a boundary.
stub("../components/os/department/ComposerContext", {
  __esModule: true,
  ComposerProvider: ({ children }: { children?: unknown }) => children,
  useComposer: () => {
    throw new Error("client hook called under react-server");
  },
});
const linkPath = require.resolve("next/link");
require.cache[linkPath] = {
  id: linkPath,
  filename: linkPath,
  path: dirname(linkPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    __esModule: true,
    default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: ReactNS.ReactNode }) =>
      ReactNS.createElement("a", { href, ...rest }, children),
  },
} as unknown as NodeModule;

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // OASIS owner
  adon: u(2, "adon@oasisai.work"), // OASIS admin
  rep: u(3, "rep@oasisai.work"), // OASIS opener → sales persona
  marketer: u(4, "marketer@oasisai.work"), // OASIS marketing persona
  manager: u(5, "manager@oasisai.work"), // OASIS manager
  worker: u(6, "worker@oasisai.work"), // OASIS member → worker
  reader: u(7, "reader@oasisai.work"), // OASIS read_only
  clientOwner: u(8, "owner@client.test"), // owner of the CLIENT workspace
  clientRep: u(9, "rep@client.test"), // CLIENT agent → sales persona
  clientWorker: u(10, "worker@client.test"), // CLIENT member → worker persona (Client Success)
} as const;
type Who = keyof typeof USERS;

async function login(who: Who | null): Promise<void> {
  if (!who) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: USERS[who].id, email: USERS[who].email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/** Split a migration the way scripts/apply_turso_migration.py does. */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    buf.push(line);
    if (t.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, ""));
      buf = [];
    }
  }
  if (buf.join("").trim()) out.push(buf.join("\n").trim());
  return out;
}

const MIGRATION = join(ROOT, "database", "turso", "bravo__186_os_approvals.sql");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const req = (url: string, body?: unknown, raw?: string) =>
  new Request(url, {
    method: body === undefined && raw === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** Every React element reachable in a tree; function components are called when they can be (hooks cannot). */
type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, out: { strings: string[]; elements: El[] } = { strings: [], elements: [] }, depth = 0) {
  if (depth > 120 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.strings.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out, depth + 1);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    out.elements.push({ type: el.type, props: el.props });
    if (typeof el.type === "function") {
      try {
        walk((el.type as (p: unknown) => unknown)(el.props), out, depth + 1);
        return out;
      } catch {
        // A client component (hooks): its props are what it would render.
      }
    }
    walk(el.props, out, depth + 1);
    return out;
  }
  if (typeof node === "object") {
    // A props object: its values (children, and element-valued props) render.
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, out, depth + 1);
  }
  return out;
}

async function main() {
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, custom_fields TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT, source_agent TEXT,
      target_agent TEXT, severity TEXT, correlation_id TEXT, payload TEXT, published_at TEXT, created_at TEXT,
      status TEXT);
    -- The founders marketing tables, in their transpiled Turso shape.
    CREATE TABLE marketing_asset (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT, status TEXT,
      brand_slug TEXT, format TEXT, asset_type TEXT, slide_count INTEGER, media_urls TEXT,
      hook TEXT, body TEXT, cta TEXT, landing_url TEXT);
    CREATE TABLE marketing_asset_media (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      kind TEXT, storage_bucket TEXT, storage_path TEXT);
    CREATE TABLE marketing_publish_intent (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      platforms TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', requested_by TEXT NOT NULL, note TEXT,
      result TEXT NOT NULL DEFAULT '{}', error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT);
  `);
  for (const stmt of splitSql(readFileSync(MIGRATION, "utf8"))) await raw.execute(stmt);

  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const clientManifest = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "client-co", answers: {} }));
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (who: Who, tenant: string, role: string, owner: 0 | 1 = 0, name?: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
            display_name, agents_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["bravo"]', ?)`,
    args: [`p-${who}`, USERS[who].id, USERS[who].email, tenant, role, owner, stamp, name ?? null, stamp],
  });
  await raw.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client', ?, 'client-co', ?, 1, 1, '2026-01-01', '2026-01-01')",
        args: [CLIENT, JSON.stringify(clientManifest)],
      },
      profile("cc", OASIS, "owner", 1, "CC"),
      profile("adon", OASIS, "admin", 0, "Adon"),
      profile("rep", OASIS, "opener", 0, "Riley Rep"),
      profile("marketer", OASIS, "marketing"),
      profile("manager", OASIS, "manager"),
      profile("worker", OASIS, "member"),
      profile("reader", OASIS, "read_only"),
      profile("clientOwner", CLIENT, "owner", 1, "Client Owner"),
      profile("clientRep", CLIENT, "agent"),
      profile("clientWorker", CLIENT, "member"),
    ],
    "write",
  );

  const rules = await import("../lib/os/approvals/rules");
  const store = await import("../lib/os/approvals/store");
  const { executeApproval } = await import("../lib/os/approvals/execute");
  const { SUNBIZ_RETIRED_TENANT_ID } = await import("../lib/tenant/retired");
  const executors = await import("../lib/os/approvals/executors");
  const { buildApprovalViews } = await import("../lib/os/approvals/view");
  const { approvalScopeFromViewer } = await import("../lib/os/approvals/scope");
  const { describeOutcome, EXECUTING_STALE_MS, newerApproval } = await import("../components/os/approvals/outcome");
  const { statusFor } = await import("../components/os/department/StatusPill");
  const { createTursoPostgrest } = await import("../lib/turso-postgrest");
  const { capabilitiesFor, resolvePersona } = await import("../lib/role-surfaces");
  const { resolveOsModules } = await import("../lib/os/modules");
  const { isOasisSurfaceTenant } = await import("../lib/role-surfaces");
  type ExecutorDeps = import("../lib/os/approvals/executors").ExecutorDeps;
  type SendEmailArgs = import("../lib/os/approvals/executors").SendEmailArgs;
  type ApprovalScope = import("../lib/os/approvals/rules").ApprovalScope;

  // ── fakes: a mailbox that records instead of sending ────────────────────
  const sent: SendEmailArgs[] = [];
  const tape: Array<Parameters<ExecutorDeps["publishEvent"]>[0]> = [];
  const fakeDeps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({
    publishEvent: async (e) => {
      tape.push(e);
    },
    isDryRun: () => false,
    sendEmail: async (args) => {
      sent.push(args);
      // Widen the race window: a second executor that got past the claim
      // would be inside here at the same time as the first.
      await new Promise((r) => setTimeout(r, 15));
      return { ok: true, provider: "oasis_shared_gmail", gmail_message_id: `<m-${sent.length}@oasisai.work>`, from_address: "team@oasisai.work" };
    },
    emailSuppression: async () => ({ suppressed: false, checkFailed: false }),
    marketingDb: () => createTursoPostgrest(raw) as never,
    marketingSql: () => raw,
    foundersTenantIds: () => [OASIS],
    signerFor: (email) => (email ? { name: "Test Signer", email } : null),
    ...over,
  });

  /** A viewer scope built exactly as the pages and routes build it. */
  const scopeFor = (who: Who, tenantId: string, slug: string, role: string, isOwner = false): ApprovalScope => {
    const persona = resolvePersona({ teamRole: role, isTrueAdmin: isOwner || role === "owner" || role === "admin" });
    const capabilities = capabilitiesFor(persona, slug);
    return approvalScopeFromViewer({
      surface: { tenantId, userId: USERS[who].id, persona, capabilities },
      navInput: {
        persona,
        capabilities,
        isOperator: false,
        tenantSlug: slug,
        isOasisTenant: isOasisSurfaceTenant(slug),
        modules: resolveOsModules({ tenantSlug: slug, provisioned: true }),
        provisioned: true,
        founders: null,
      },
    });
  };
  const S = {
    cc: scopeFor("cc", OASIS, "oasis-ai-cc", "owner", true),
    rep: scopeFor("rep", OASIS, "oasis-ai-cc", "opener"),
    marketer: scopeFor("marketer", OASIS, "oasis-ai-cc", "marketing"),
    manager: scopeFor("manager", OASIS, "oasis-ai-cc", "manager"),
    worker: scopeFor("worker", OASIS, "oasis-ai-cc", "member"),
    reader: scopeFor("reader", OASIS, "oasis-ai-cc", "read_only"),
    clientOwner: scopeFor("clientOwner", CLIENT, "client-co", "owner", true),
  };

  const email = (to: string, subject = "Following up", body = "Hi — checking in on the proposal.") => ({ to, subject, body });
  let seq = 0;
  const create = async (over: Record<string, unknown> = {}) => {
    seq += 1;
    const r = await store.createApproval(
      raw,
      {
        tenantId: OASIS,
        departmentKey: "sales",
        requestedBy: { type: "agent", id: "sdr" },
        actionKind: "send_email",
        title: `Email ${seq}`,
        payload: email(`lead${seq}@example.test`),
        ...over,
      },
      new Date(),
    );
    assert.ok(r.ok, `create failed: ${JSON.stringify(r)}`);
    return r.approval;
  };
  /** The asset_hash a publish_post approval carries, read exactly as the executor reads it. */
  const publishHashOf = async (tenantId: string, assetId: string): Promise<string> => {
    const r = await executors.readPublishAsset(createTursoPostgrest(raw) as never, tenantId, assetId);
    if (!r.ok || !r.assetHash) throw new Error(`cannot hash ${assetId}: ${JSON.stringify(r)}`);
    return r.assetHash;
  };
  const events = async (tenantId: string, id: string) =>
    (await raw.execute({ sql: "SELECT event FROM approval_events WHERE tenant_id = ? AND approval_id = ? ORDER BY created_at, rowid", args: [tenantId, id] })).rows.map(
      (r) => String(r.event),
    );
  const statusOf = async (id: string) => String((await raw.execute({ sql: "SELECT status FROM approvals WHERE id = ?", args: [id] })).rows[0]?.status);

  console.log("os-approvals:");

  // ── 1. Rules (pure) ────────────────────────────────────────────────────
  await check("rules: the status vocabulary is exactly the eight states, and only these edges exist", () => {
    assert.deepEqual([...rules.APPROVAL_STATUSES], ["pending", "approved", "sent_back", "expired", "executing", "executed", "failed", "cancelled"]);
    const edges = rules.APPROVAL_STATUSES.flatMap((f) => rules.APPROVAL_STATUSES.filter((t) => rules.canTransition(f, t)).map((t) => `${f}>${t}`));
    assert.deepEqual(edges.sort(), [
      "approved>executing",
      "executing>executed",
      "executing>failed",
      "pending>approved",
      "pending>cancelled",
      "pending>expired",
      "pending>sent_back",
    ]);
    for (const t of rules.TERMINAL_STATUSES) assert.deepEqual(rules.APPROVAL_TRANSITIONS[t], [], `${t} is terminal`);
  });

  await check("rules: canonical JSON is key-order independent, so the hash binds the content, not its spelling", () => {
    assert.equal(rules.canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    assert.equal(rules.canonicalJson({ to: "x", subject: "s" }), rules.canonicalJson({ subject: "s", to: "x" }));
    assert.notEqual(rules.canonicalJson({ a: [1, 2] }), rules.canonicalJson({ a: [2, 1] }), "array order is meaning");
  });

  await check("rules: an email payload is normalised and refuses header injection, bad addresses and empties", () => {
    const ok = rules.validateSendEmailPayload({ to: " Lee@Harbour.TEST ", cc: ["a@b.test", "lee@harbour.test", "A@B.test"], subject: "Hi", body: "Body\r\n" });
    assert.deepEqual(ok, { ok: true, value: { to: "lee@harbour.test", cc: ["a@b.test"], subject: "Hi", body: "Body" } });
    assert.equal(rules.validateSendEmailPayload({ to: "lee@harbour.test", subject: "Hi\r\nBcc: x@y.test", body: "b" }).ok, false);
    assert.equal(rules.validateSendEmailPayload({ to: "not-an-email", subject: "s", body: "b" }).ok, false);
    assert.equal(rules.validateSendEmailPayload({ to: "a@b.test", subject: " ", body: "b" }).ok, false);
    assert.equal(rules.validateSendEmailPayload({ to: "a@b.test", subject: "s", body: "" }).ok, false);
    assert.equal(rules.validatePublishPostPayload({ asset_id: "x", platforms: ["instagram", "myspace"] }).ok, false, "never fewer surfaces than asked");
    assert.equal(rules.validateNewApproval({ tenantId: OASIS, departmentKey: "sales", requestedBy: { type: "agent", id: "x" }, actionKind: "wire_money", title: "t", payload: {} }).ok, false);
    assert.deepEqual(rules.validateNewApproval({ tenantId: " ", actionKind: "send_email" }), { ok: false, error: "tenant_required" });
  });

  await check("rules: a post payload must carry the hash of the asset content it approves; the snapshot is what the publisher posts", () => {
    const hash = sha("asset content");
    assert.deepEqual(rules.validatePublishPostPayload({ asset_id: "a", platforms: ["instagram"] }), { ok: false, error: "asset_hash_required", field: "asset_hash" });
    assert.equal(rules.validatePublishPostPayload({ asset_id: "a", asset_hash: "nope", platforms: ["instagram"] }).ok, false);
    assert.deepEqual(rules.validatePublishPostPayload({ asset_id: "a", asset_hash: hash, platforms: ["Instagram"] }), {
      ok: true,
      value: { asset_id: "a", asset_hash: hash, platforms: ["instagram"] },
    });
    const asset = { title: "Reel", hook: "Stop scrolling", body: "Caption", cta: "Book", landing_url: "https://x.test", media_urls: '["b.png","a.png"]', slide_count: 2, asset_type: "carousel", format: "carousel" };
    const media = [{ kind: "image", storage_bucket: "m", storage_path: "a.png" }, { kind: "image", storage_bucket: "m", storage_path: "b.png" }];
    const base = rules.publishAssetSnapshot(asset, media);
    assert.equal(rules.publishAssetSnapshot({ ...asset, media_urls: ["b.png", "a.png"] }, [...media].reverse()), base, "JSON text and array are the same slides; media rows are a set");
    for (const [label, changed] of [
      ["caption", rules.publishAssetSnapshot({ ...asset, body: "Other caption" }, media)],
      ["hook", rules.publishAssetSnapshot({ ...asset, hook: "Other hook" }, media)],
      ["cta", rules.publishAssetSnapshot({ ...asset, cta: "Call" }, media)],
      ["landing", rules.publishAssetSnapshot({ ...asset, landing_url: "https://y.test" }, media)],
      ["title", rules.publishAssetSnapshot({ ...asset, title: "Other" }, media)],
      ["slide order", rules.publishAssetSnapshot({ ...asset, media_urls: '["a.png","b.png"]' }, media)],
      ["a swapped file", rules.publishAssetSnapshot(asset, [media[0], { ...media[1], storage_path: "c.png" }])],
    ] as const) {
      assert.notEqual(changed, base, `${label} changes the snapshot`);
    }
  });

  await check("department header: an approvals read that failed never lets the header say Working (statusFor + the page)", () => {
    // The count behind the header is a floor when a read failed; a floor of 0 is unknown, not "nothing waiting".
    assert.deepEqual(statusFor(true, 0, true), { kind: "unknown" });
    assert.deepEqual(statusFor(true, 0, false), { kind: "working" });
    assert.deepEqual(statusFor(true, 3, true), { kind: "needs_you", count: 3, capped: true }, "attention items still count, as a floor");
    const code = readFileSync(join(ROOT, "app/team/[dept]/page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.match(
      code,
      /const needsYouCapped = numbers\.attention\.some\(\(item\) => item\.capped === true\) \|\| !approvals\.ok;/,
      "a failed approvals read makes the header's total a floor",
    );
    assert.match(code, /statusFor\(channel\.kind === "ready", needsYou, needsYouCapped\)/);
  });

  await check("card: a refreshed row replaces the shown one unless the shown one is newer, and the card follows its prop", () => {
    const row = (updated_at: string, comments = 0) => ({
      updated_at,
      comments: Array.from({ length: comments }, (_, i) => ({ id: `c${i}`, body: "Looks right.", author_id: null, author_name: null, created_at: updated_at })),
    });
    const pendingAt0 = row("2026-09-28T10:00:00.000Z");
    const executedAt1 = row("2026-09-28T10:01:00.000Z");
    assert.equal(newerApproval(pendingAt0, executedAt1), executedAt1, "a refresh shows the executor's result");
    assert.equal(newerApproval(executedAt1, pendingAt0), executedAt1, "a stale refresh cannot roll the card back");
    const commented = row("2026-09-28T10:00:00.000Z", 1);
    assert.equal(newerApproval(pendingAt0, commented), commented, "a teammate's comment arrives on refresh");
    assert.equal(newerApproval(commented, pendingAt0), commented, "nor can it drop a comment this card just posted");
    const again = row("2026-09-28T10:00:00.000Z");
    assert.equal(newerApproval(pendingAt0, again), again, "a tie goes to the server's copy (it carries a virtual expiry)");
    // The card applies it whenever its prop changes and no click is in flight.
    const card = readFileSync(join(ROOT, "components/os/approvals/ApprovalCard.tsx"), "utf8");
    assert.match(card, /if \(initial !== synced && busy === null\) \{\s*setSynced\(initial\);\s*setApproval\(newerApproval\(approval, initial\)\);/);
  });

  await check("card: every email recipient is shown in full, wrapped, never cut to an ellipsis", () => {
    const card = readFileSync(join(ROOT, "components/os/approvals/ApprovalCard.tsx"), "utf8");
    const preview = card.slice(card.indexOf("function EmailPreview"), card.indexOf("function PostPreview"));
    assert.ok(preview.length > 200, "found EmailPreview");
    assert.doesNotMatch(preview, /\btruncate\b|text-ellipsis|line-clamp-1\b/, "a recipient hidden behind an ellipsis");
    assert.match(preview, /<dd className="break-all[^"]*">\{str\(payload\.to\)\}<\/dd>/);
    assert.match(preview, /<dd className="break-all[^"]*">\{cc\.join\(", "\)\}<\/dd>/);
  });

  await check("rules: seats — owners decide everything; others only their own department, only if the rail opens it", () => {
    const all = new Set(rules.DEPARTMENT_KEYS);
    const scope = (persona: Parameters<typeof rules.approvalScopeFor>[0]["persona"], canAct = true, open = all) =>
      rules.approvalScopeFor({ tenantId: OASIS, userId: "u", persona, canAct, openDepartments: open });
    const f = scope("founder");
    assert.equal(rules.mayDecideApproval(f, null), true, "an owner decides unattributed approvals");
    for (const d of rules.DEPARTMENT_KEYS) assert.equal(rules.mayDecideApproval(f, d), true);
    const s = scope("sales");
    assert.deepEqual(rules.DEPARTMENT_KEYS.filter((d) => rules.mayDecideApproval(s, d)), ["sales"]);
    assert.equal(rules.mayDecideApproval(s, null), false, "unattributed is owners only");
    assert.deepEqual(rules.DEPARTMENT_KEYS.filter((d) => rules.mayDecideApproval(scope("marketing"), d)), ["marketing"]);
    assert.deepEqual(rules.DEPARTMENT_KEYS.filter((d) => rules.mayDecideApproval(scope("manager"), d)), ["sales"]);
    assert.deepEqual(rules.DEPARTMENT_KEYS.filter((d) => rules.mayDecideApproval(scope("legacy"), d)), [], "SunBiz roles have no seat");
    const ro = scope("readonly", false);
    assert.equal(rules.mayViewApproval(ro, "client_success"), true);
    assert.equal(rules.mayDecideApproval(ro, "client_success"), false, "read-only sees, never decides");
    const closed = scope("sales", true, new Set(["chief_of_staff"] as const));
    assert.equal(rules.mayViewApproval(closed, "sales"), false, "a department the rail does not open contributes nothing");
    assert.equal(rules.scopeSeesNothing(closed), true);
  });

  await check("rules: every OASIS department binding resolves to a home department for propose_email", async () => {
    const { departmentChannelFor } = await import("../components/os/department/config");
    for (const d of rules.DEPARTMENT_KEYS) {
      const b = departmentChannelFor(d, { oasis: true });
      assert.equal(b.kind, "agent");
      if (b.kind !== "agent") continue;
      const home = rules.departmentForAgent(b.agentSlug);
      assert.ok(home === d || (b.agentSlug === "bravo" && d === "operations"), `${b.agentSlug} → ${home}, bound to ${d}`);
    }
    assert.equal(rules.departmentForAgent("constructor"), null, "no prototype keys");
  });

  await check("outcome wording: only the executor's recorded outcome can say Sent", () => {
    const fmt = () => "10:42 AM";
    const base = { action_kind: "send_email" as const, decided_at: "2026-09-28T14:00:00Z", decided_by_name: "Adon", decision_note: null, executing_at: null, executed_at: "2026-09-28T14:42:00Z", expires_at: null, updated_at: "2026-09-28T14:42:00Z" };
    const now = Date.parse("2026-09-28T15:00:00Z");
    assert.equal(describeOutcome({ ...base, status: "executed", execution_result: { outcome: "sent", provider: "x" } }, fmt, now)?.text, "Sent ✓ 10:42 AM");
    const dry = describeOutcome({ ...base, status: "executed", execution_result: { outcome: "dry_run", provider: "x" } }, fmt, now);
    assert.match(dry!.text, /^Dry run ✓/);
    assert.match(dry!.detail!, /Nothing was sent/);
    assert.match(describeOutcome({ ...base, status: "executed", execution_result: { outcome: "queued", provider: "x" } }, fmt, now)!.text, /^Queued to publish ✓/);
    assert.equal(describeOutcome({ ...base, status: "failed", execution_result: { outcome: "failed", reason: "suppressed", message: "The recipient has opted out." } }, fmt, now)?.text, "Failed: The recipient has opted out.");
    const noResult = describeOutcome({ ...base, status: "executed", execution_result: null }, fmt, now)!;
    assert.doesNotMatch(noResult.text, /Sent/, "an executed row with no outcome never claims Sent");
    assert.doesNotMatch(describeOutcome({ ...base, status: "approved", execution_result: null }, fmt, now)!.text, /Sent/);
    const stale = describeOutcome({ ...base, status: "executing", executing_at: new Date(now - EXECUTING_STALE_MS - 1000).toISOString(), execution_result: null }, fmt, now)!;
    assert.equal(stale.tone, "warn");
    assert.match(stale.detail!, /Check before approving/);
    assert.match(describeOutcome({ ...base, status: "sent_back", decision_note: "Shorter please", execution_result: null }, fmt, now)!.detail!, /Shorter please/);
    assert.equal(describeOutcome({ ...base, status: "pending", execution_result: null }, fmt, now), null);
  });

  // ── 2. The migration's shape ───────────────────────────────────────────
  await check("migration: no CHECK constraints, every index leads with tenant_id, idempotency unique per tenant, re-run harmless", async () => {
    const ddl = (await raw.execute("SELECT name, sql FROM sqlite_master WHERE name IN ('approvals', 'approval_events')")).rows;
    assert.equal(ddl.length, 2);
    for (const r of ddl) assert.doesNotMatch(String(r.sql), /\bCHECK\b/i, `${r.name} has a CHECK constraint`);
    for (const table of ["approvals", "approval_events"]) {
      const cols = (await raw.execute(`PRAGMA table_info(${table})`)).rows;
      const tenant = cols.find((c) => c.name === "tenant_id");
      assert.equal(Number(tenant?.notnull), 1, `${table}.tenant_id is NOT NULL`);
      const idx = (await raw.execute(`PRAGMA index_list(${table})`)).rows.filter((i) => !String(i.name).startsWith("sqlite_autoindex"));
      assert.ok(idx.length > 0);
      for (const i of idx) {
        const first = (await raw.execute(`PRAGMA index_info(${String(i.name)})`)).rows.find((c) => Number(c.seqno) === 0);
        assert.equal(first?.name, "tenant_id", `${table}.${i.name} leads with ${first?.name}`);
      }
    }
    const uq = (await raw.execute("PRAGMA index_list(approvals)")).rows.find((i) => i.name === "uq_appr_idem");
    assert.equal(Number(uq?.unique), 1);
    for (const stmt of splitSql(readFileSync(MIGRATION, "utf8"))) await raw.execute(stmt);
    assert.doesNotMatch(readFileSync(MIGRATION, "utf8").replace(/--.*$/gm, ""), /\bDROP\b/i, "additive only");
  });

  // ── 3. Lifecycle ───────────────────────────────────────────────────────
  await check("lifecycle: create → pending with a canonical payload and hash → approve → execute → Sent, all audited", async () => {
    const a = await create({ payload: { subject: "Your quote", body: "Here it is.", to: "Lee@Harbour.test" } });
    assert.equal(a.status, "pending");
    assert.equal(a.revision, 1);
    assert.equal(a.payload_json, '{"body":"Here it is.","subject":"Your quote","to":"lee@harbour.test"}');
    assert.equal(a.payload_hash, sha(a.payload_json));
    assert.ok(a.expires_at && a.expires_at > a.created_at, "a pending approval expires");
    const listed = await store.listApprovals(raw, S.cc, { view: "pending" }, new Date());
    assert.ok(listed.rows.some((r) => r.id === a.id));

    const d = await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    assert.ok(d.ok);
    assert.equal(d.approval.status, "approved");
    assert.equal(d.approval.decided_by, USERS.cc.id, "the decider is the session user");
    assert.equal(d.approval.decided_by_name, "CC");

    const before = sent.length;
    const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, fakeDeps());
    assert.ok(x.ok);
    assert.equal(x.approval.status, "executed");
    assert.deepEqual(x.approval.execution_result, { outcome: "sent", provider: "oasis_shared_gmail", message_id: `<m-${before + 1}@oasisai.work>`, from: "team@oasisai.work" });
    assert.equal(sent.length, before + 1);
    const m = sent[sent.length - 1];
    assert.equal(m.to, "lee@harbour.test");
    assert.equal(m.tenantId, OASIS);
    assert.equal(m.idempotencyKey, a.idempotency_key, "the provider gets the approval's idempotency key");
    assert.deepEqual(m.cc, [USERS.cc.email], "the approver is copied");
    assert.equal(m.signer?.email, USERS.cc.email, "the approver signs");
    assert.deepEqual(await events(OASIS, a.id), ["created", "approved", "execution_started", "executed"]);
    const t = tape[tape.length - 1];
    assert.deepEqual(
      [t.eventType, t.tenantId, t.publisher, t.severity, t.payload?.approval_id, t.payload?.to, t.payload?.subject],
      ["APPROVAL_SENT", OASIS, "dept:sales", "info", a.id, "lee@harbour.test", "Your quote"],
      "the Feed's tape gets the send, attributed to the department",
    );
  });

  await check("tape: only a real send is *_SENT (Shipped); dry runs, queued posts and failures say what they are; a tape outage changes nothing", async () => {
    const fm = await import("../components/os/landings/feed-model");
    const shipped = (eventType: string, severity = "info") => fm.isShipped({ event_type: eventType, severity });
    assert.equal(shipped("APPROVAL_SENT"), true);
    for (const t of ["APPROVAL_DRY_RUN", "APPROVAL_QUEUED", "APPROVAL_EXECUTED"]) assert.equal(shipped(t), false, t);
    assert.equal(shipped("APPROVAL_FAILED", "error"), false);
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    const quiet = console.error;
    console.error = () => {};
    try {
      const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps({ publishEvent: async () => { throw new Error("bus down"); } }));
      assert.ok(x.ok);
      assert.equal(x.approval.status, "executed", "the email went; a tape outage does not unsend it");
      assert.equal(x.approval.execution_result?.outcome, "sent");
    } finally {
      console.error = quiet;
    }
  });

  await check("dry run (the deployment default): executed with outcome dry_run and the mailbox never called", async () => {
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    const before = sent.length;
    const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps({ isDryRun: executors.defaultExecutorDeps().isDryRun }));
    assert.ok(x.ok);
    assert.equal(x.approval.status, "executed");
    assert.equal(x.approval.execution_result?.outcome, "dry_run");
    assert.equal(sent.length, before, "a dry run sends nothing");
  });

  await check("opt-out: a proposed Cc on the suppression list, or a list that cannot be read, fails the send and the mailbox is never called", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const [supp, reason] of [
        [{ suppressed: true, checkFailed: false }, "suppressed"],
        [{ suppressed: false, checkFailed: true }, "suppression_error"],
      ] as const) {
        const a = await create({ payload: { to: "lee@harbour.test", cc: ["OptOut@Harbour.test"], subject: "Copy test", body: "Hello." } });
        await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
        const before = sent.length;
        const asked: string[] = [];
        const x = await executeApproval(
          raw,
          { tenantId: OASIS, approvalId: a.id, approver: { userId: USERS.cc.id, email: USERS.cc.email } },
          fakeDeps({
            emailSuppression: async (tenantId, addr) => {
              asked.push(`${tenantId}|${addr}`);
              return supp;
            },
          }),
        );
        assert.ok(x.ok);
        assert.equal(x.approval.status, "failed");
        const r = x.approval.execution_result;
        assert.equal(r?.outcome === "failed" ? r.reason : null, reason);
        assert.equal(sent.length, before, "nothing was sent");
        assert.deepEqual(asked, [`${OASIS}|optout@harbour.test`], "only the proposed copy is looked up, in the approval's own workspace");
      }
    } finally {
      console.error = quiet;
    }
  });

  await check("a refused send is a recorded failure with the reason; running it again sends nothing", async () => {
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    let calls = 0;
    const deps = fakeDeps({
      sendEmail: async () => {
        calls += 1;
        return { ok: false, provider: "oasis_shared_gmail", reason: "suppressed", error: "recipient in email_suppressions" };
      },
    });
    const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, deps);
    assert.ok(x.ok);
    assert.equal(x.approval.status, "failed");
    assert.deepEqual(x.approval.execution_result, {
      outcome: "failed",
      reason: "suppressed",
      message: "The recipient has opted out of email, so nothing was sent.",
      provider: "oasis_shared_gmail",
    });
    const again = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, deps);
    assert.deepEqual([again.ok, !again.ok && again.error], [false, "not_claimable"]);
    assert.equal(calls, 1, "failed is terminal: no second attempt");
  });

  await check("an executor that throws is a recorded failure with its message, never a success", async () => {
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    const quiet = console.error;
    console.error = () => {};
    try {
      const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps({ sendEmail: async () => { throw new Error("socket hang up"); } }));
      assert.ok(x.ok);
      assert.equal(x.approval.status, "failed");
      assert.equal(x.approval.execution_result?.outcome, "failed");
      assert.match((x.approval.execution_result as { message: string }).message, /socket hang up/);
    } finally {
      console.error = quiet;
    }
  });

  // ── 4. Payload-hash binding ────────────────────────────────────────────
  await check("binding: approving with any other hash is payload_mismatch and the row stays pending", async () => {
    const a = await create();
    const wrong = await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: sha("something else") }, new Date());
    assert.deepEqual(wrong, { ok: false, error: "payload_mismatch", field: "payload_hash" });
    const missing = await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: "" }, new Date());
    assert.equal(!missing.ok && missing.error, "payload_hash_required");
    assert.equal(await statusOf(a.id), "pending");
    assert.deepEqual(await events(OASIS, a.id), ["created"], "a refused approve writes no event");
  });

  await check("binding: a payload changed around the store after approval is refused at execution, and nothing is sent", async () => {
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    await raw.execute({
      sql: "UPDATE approvals SET payload_json = ? WHERE id = ?",
      args: [rules.canonicalJson(email("someone-else@evil.test", "Wire the money", "Now.")), a.id],
    });
    const before = sent.length;
    const quiet = console.error;
    console.error = () => {};
    try {
      const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps());
      assert.ok(x.ok);
      assert.equal(x.approval.status, "failed");
      assert.equal((x.approval.execution_result as { reason: string }).reason, "payload_changed");
    } finally {
      console.error = quiet;
    }
    assert.equal(sent.length, before, "nothing sent");
  });

  await check("binding: an edit is a NEW approval (revision 2) that supersedes; the old one cannot then be approved", async () => {
    const a = await create();
    const r2 = await store.createApproval(
      raw,
      { tenantId: OASIS, departmentKey: "sales", requestedBy: { type: "agent", id: "sdr" }, actionKind: "send_email", title: "Email v2", payload: email("x@y.test", "Better subject"), supersedesId: a.id },
      new Date(),
    );
    assert.ok(r2.ok && r2.created);
    assert.equal(r2.approval.revision, 2);
    assert.equal(r2.approval.supersedes_id, a.id);
    assert.equal(await statusOf(a.id), "cancelled", "a pending original is withdrawn in the same batch");
    assert.deepEqual(await events(OASIS, a.id), ["created", "superseded"]);
    const late = await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    assert.deepEqual(late, { ok: false, error: "not_pending", status: "cancelled" });
    const again = await store.createApproval(
      raw,
      { tenantId: OASIS, departmentKey: "sales", requestedBy: { type: "agent", id: "sdr" }, actionKind: "send_email", title: "Email v2b", payload: email("x@y.test", "Other"), supersedesId: a.id },
      new Date(),
    );
    assert.equal(!again.ok && again.error, "already_revised", "one draft cannot fork into two live revisions");
  });

  await check("idempotency: the same key and payload returns the first row; the same key with another payload is refused", async () => {
    const input = { tenantId: OASIS, departmentKey: "sales" as const, requestedBy: { type: "agent" as const, id: "sdr" }, actionKind: "send_email" as const, title: "Idem", payload: email("i@d.test"), idempotencyKey: "k-1" };
    const first = await store.createApproval(raw, input, new Date());
    const second = await store.createApproval(raw, { ...input, payload: { subject: "Following up", to: "i@d.test", body: "Hi — checking in on the proposal." } }, new Date());
    assert.ok(first.ok && second.ok);
    assert.equal(second.created, false);
    assert.equal(second.approval.id, first.approval.id);
    const reused = await store.createApproval(raw, { ...input, payload: email("other@d.test") }, new Date());
    assert.deepEqual(reused, { ok: false, error: "idempotency_key_reused" });
    assert.equal((await raw.execute({ sql: "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND idempotency_key = 'k-1'", args: [OASIS] })).rows[0].n, 1);
    const inClient = await store.createApproval(raw, { ...input, tenantId: CLIENT }, new Date());
    assert.ok(inClient.ok && inClient.created, "the key is unique per tenant, not globally");
  });

  await check("expiry: a pending approval past expires_at is refused and marked expired", async () => {
    const a = await create({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const later = new Date(Date.now() + 120_000);
    assert.ok(!(await store.listApprovals(raw, S.cc, { view: "pending" }, later)).rows.some((r) => r.id === a.id), "not in the queue");
    const d = await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, later);
    assert.deepEqual(d, { ok: false, error: "expired", status: "expired" });
    assert.equal(await statusOf(a.id), "expired");
    assert.deepEqual(await events(OASIS, a.id), ["created", "expired"]);
  });

  // ── 5. Exactly once ────────────────────────────────────────────────────
  await check("exactly once: eight concurrent executions of one approval send ONE email and log one start and one finish", async () => {
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    const before = sent.length;
    // Separate connections to the same file: the claim has to hold across
    // clients, not only inside one.
    const clients: Client[] = Array.from({ length: 8 }, () => createClient({ url: `file:${dbFile}` }));
    const results = await Promise.all(clients.map((c) => executeApproval(c, { tenantId: OASIS, approvalId: a.id }, fakeDeps())));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => (r.ok ? "ok" : r.error))));
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "not_claimable"));
    assert.equal(sent.length - before, 1, "one email");
    const ev = await events(OASIS, a.id);
    assert.equal(ev.filter((e) => e === "execution_started").length, 1);
    assert.equal(ev.filter((e) => e === "executed").length, 1);
    for (const c of clients) c.close();
  });

  await check("exactly once: five concurrent approves of one row — one wins, one approved event", async () => {
    const a = await create();
    const clients: Client[] = Array.from({ length: 5 }, () => createClient({ url: `file:${dbFile}` }));
    const results = await Promise.all(clients.map((c) => store.decideApproval(c, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date())));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "not_pending"));
    assert.equal((await events(OASIS, a.id)).filter((e) => e === "approved").length, 1);
    for (const c of clients) c.close();
  });

  await check("a row left in executing (a crash mid-send) is never re-run from here", async () => {
    const a = await create();
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    assert.equal(await store.claimForExecution(raw, OASIS, a.id, new Date()), true);
    const before = sent.length;
    const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps());
    assert.deepEqual([x.ok, !x.ok && x.error, x.approval?.status], [false, "not_claimable", "executing"]);
    assert.equal(sent.length, before);
  });

  // ── 6. Send back needs a note; comments ────────────────────────────────
  await check("send back: no note is refused; with a note the row is sent_back and the note is kept for the agent", async () => {
    const a = await create();
    for (const note of [undefined, "", "   "]) {
      const r = await store.decideApproval(raw, S.cc, a.id, { kind: "send_back", note }, new Date());
      assert.deepEqual(r, { ok: false, error: "note_required", field: "note" });
    }
    assert.equal(await statusOf(a.id), "pending");
    const r = await store.decideApproval(raw, S.cc, a.id, { kind: "send_back", note: "Too pushy — soften the ask." }, new Date());
    assert.ok(r.ok);
    assert.equal(r.approval.status, "sent_back");
    assert.equal(r.approval.decision_note, "Too pushy — soften the ask.");
    const ev = await store.listApprovalEvents(raw, S.cc, a.id);
    assert.deepEqual(ev.map((e) => e.event), ["created", "sent_back"]);
    assert.equal(ev[1].meta?.note, "Too pushy — soften the ask.");
    const approve = await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    assert.deepEqual(approve, { ok: false, error: "not_pending", status: "sent_back" });
    const rev = await store.createApproval(
      raw,
      { tenantId: OASIS, departmentKey: "sales", requestedBy: { type: "agent", id: "sdr" }, actionKind: "send_email", title: "Softer", payload: email("x@y.test", "Softer"), supersedesId: a.id },
      new Date(),
    );
    assert.ok(rev.ok && rev.approval.revision === 2);
    assert.equal(await statusOf(a.id), "sent_back", "a sent-back row keeps its note and its status");
  });

  await check("comment: required, does not change status, readable with its author through the scoped parent", async () => {
    const a = await create();
    assert.equal((await store.commentOnApproval(raw, S.cc, a.id, "  ", new Date())).ok, false);
    const c = await store.commentOnApproval(raw, S.cc, a.id, "Can we mention the deadline?", new Date());
    assert.ok(c.ok);
    assert.equal(c.comment.author_name, "CC");
    assert.equal(await statusOf(a.id), "pending");
    const map = await store.listApprovalComments(raw, S.cc, [a.id]);
    assert.deepEqual(map.get(a.id)?.map((x) => x.body), ["Can we mention the deadline?"]);
  });

  // ── 7. Unknown kinds fail loudly ───────────────────────────────────────
  await check("no executor: an approved send_sms is FAILED 'no executor for send_sms' and nothing is sent", async () => {
    const a = await create({ actionKind: "send_sms", title: "Text Lee", payload: { to: "+15145550100", body: "On my way" } });
    const [view] = await buildApprovalViews(raw, S.cc, [a], { tenantSlug: "oasis-ai-cc", now: new Date(), deps: fakeDeps() });
    assert.equal(view.executable, false, "the card warns before anyone approves");
    assert.match(view.readiness_note!, /Nothing in this app can carry out a text message/);
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    const before = sent.length;
    const quiet = console.error;
    console.error = () => {};
    try {
      const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps());
      assert.ok(x.ok);
      assert.equal(x.approval.status, "failed");
      assert.match((x.approval.execution_result as { message: string }).message, /^no executor for send_sms/);
    } finally {
      console.error = quiet;
    }
    assert.equal(sent.length, before);
    assert.deepEqual(Object.keys(executors.EXECUTORS).sort(), ["publish_post", "send_email"], "only kinds with a sanctioned send path");
  });

  await check("readiness: an email from a client workspace has no sender here and fails loudly when approved", async () => {
    const r = await store.createApproval(
      raw,
      { tenantId: CLIENT, departmentKey: "sales", requestedBy: { type: "agent", id: "sdr" }, actionKind: "send_email", title: "Client email", payload: email("c@c.test") },
      new Date(),
    );
    assert.ok(r.ok);
    const [view] = await buildApprovalViews(raw, S.clientOwner, [r.approval], { tenantSlug: "client-co", now: new Date(), deps: fakeDeps() });
    assert.equal(view.executable, false);
    assert.match(view.readiness_note!, /no email sender/);
    await store.decideApproval(raw, S.clientOwner, r.approval.id, { kind: "approve", payloadHash: r.approval.payload_hash }, new Date());
    const before = sent.length;
    const quiet = console.error;
    console.error = () => {};
    try {
      const x = await executeApproval(raw, { tenantId: CLIENT, approvalId: r.approval.id }, fakeDeps());
      assert.ok(x.ok);
      assert.equal(x.approval.status, "failed");
      assert.equal((x.approval.execution_result as { reason: string }).reason, "no_sender");
    } finally {
      console.error = quiet;
    }
    assert.equal(sent.length, before, "OASIS's mailbox never sends for a client workspace");
  });

  await check("execute: a retired workspace's approved card is refused and nothing is sent", async () => {
    // Approved before the workspace was retired (lib/tenant/retired.ts): the
    // executor re-checks at run time, so a card left over from before the
    // offboarding cannot act for it.
    await raw.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'Retired Co')", args: [SUNBIZ_RETIRED_TENANT_ID] });
    const r = await create({ tenantId: SUNBIZ_RETIRED_TENANT_ID, title: "RETIRED-MARKER" });
    await raw.execute({ sql: "UPDATE approvals SET status = 'approved' WHERE tenant_id = ? AND id = ?", args: [SUNBIZ_RETIRED_TENANT_ID, r.id] });
    const before = sent.length;
    const quiet = console.error;
    console.error = () => {};
    try {
      const x = await executeApproval(raw, { tenantId: SUNBIZ_RETIRED_TENANT_ID, approvalId: r.id }, fakeDeps());
      assert.ok(x.ok);
      assert.equal(x.approval.status, "failed");
      assert.equal((x.approval.execution_result as { reason: string }).reason, "workspace_retired");
    } finally {
      console.error = quiet;
    }
    assert.equal(sent.length, before, "nothing is sent for a retired workspace");
  });

  // ── 8. Tenant isolation ────────────────────────────────────────────────
  await check("isolation: workspace B cannot list, read, decide, comment on, audit or execute workspace A's approval", async () => {
    const a = await create({ departmentKey: null, title: "OASIS-ONLY-MARKER" });
    const B = S.clientOwner;
    const now = new Date();
    for (const view of ["pending", "decided", "all"] as const) {
      const rows = (await store.listApprovals(raw, B, { view }, now)).rows;
      assert.ok(rows.every((r) => r.tenant_id === CLIENT), `${view}: a row from another tenant`);
      assert.ok(!rows.some((r) => r.id === a.id));
    }
    assert.equal(await store.getApproval(raw, B, a.id), null);
    assert.deepEqual(await store.decideApproval(raw, B, a.id, { kind: "approve", payloadHash: a.payload_hash }, now), { ok: false, error: "not_found" });
    assert.deepEqual(await store.decideApproval(raw, B, a.id, { kind: "send_back", note: "x" }, now), { ok: false, error: "not_found" });
    assert.deepEqual(await store.commentOnApproval(raw, B, a.id, "hi", now), { ok: false, error: "not_found" });
    assert.deepEqual(await store.listApprovalEvents(raw, B, a.id), []);
    assert.equal((await store.listApprovalComments(raw, B, [a.id])).size, 0);
    // Approve it in A, then try to execute it as B.
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, now);
    const x = await executeApproval(raw, { tenantId: CLIENT, approvalId: a.id }, fakeDeps());
    assert.deepEqual([x.ok, !x.ok && x.error], [false, "not_found"]);
    assert.equal(await statusOf(a.id), "approved", "B's execute did not claim A's row");
    assert.equal(await store.claimForExecution(raw, CLIENT, a.id, now), false);
    const counts = await store.countPendingApprovals(raw, B, now);
    const clientPending = Number((await raw.execute({ sql: "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND status = 'pending'", args: [CLIENT] })).rows[0].n);
    assert.equal(counts.total, clientPending);
    assert.deepEqual(await events(OASIS, a.id), ["created", "approved"], "nothing B did left a trace on A's row");
  });

  await check("isolation: an empty tenant never becomes 'every tenant'", async () => {
    await assert.rejects(store.listApprovals(raw, { ...S.cc, tenantId: "" }, { view: "all" }, new Date()), /tenant id is required/);
    await assert.rejects(store.getApprovalInTenant(raw, "  ", "x"), /tenant id is required/);
    const x = await executeApproval(raw, { tenantId: "", approvalId: "x" }, fakeDeps());
    assert.deepEqual([x.ok, !x.ok && x.error], [false, "not_found"]);
  });

  // ── 9. Persona permissions (store) ─────────────────────────────────────
  const byDept = {
    sales: await create({ departmentKey: "sales", title: "SALES-MARKER" }),
    marketing: await create({ departmentKey: "marketing", title: "MARKETING-MARKER", requestedBy: { type: "agent", id: "maven" } }),
    finance: await create({ departmentKey: "finance", title: "FINANCE-MARKER", requestedBy: { type: "agent", id: "atlas" } }),
    none: await create({ departmentKey: null, title: "UNATTRIBUTED-MARKER" }),
  };
  await check("personas: each viewer sees exactly the departments they are seated in", async () => {
    const sees = async (s: ApprovalScope) =>
      (await store.listApprovals(raw, s, { view: "pending", limit: 200 }, new Date())).rows
        .filter((r) => Object.values(byDept).some((x) => x.id === r.id))
        .map((r) => r.title)
        .sort();
    assert.deepEqual(await sees(S.cc), ["FINANCE-MARKER", "MARKETING-MARKER", "SALES-MARKER", "UNATTRIBUTED-MARKER"]);
    assert.deepEqual(await sees(S.rep), ["SALES-MARKER"]);
    assert.deepEqual(await sees(S.manager), ["SALES-MARKER"]);
    assert.deepEqual(await sees(S.marketer), ["MARKETING-MARKER"]);
    assert.deepEqual(await sees(S.worker), [], "Client Success is founder-only inside OASIS");
    assert.deepEqual(await sees(S.reader), []);
    assert.deepEqual(await store.decideApproval(raw, S.rep, byDept.marketing.id, { kind: "approve", payloadHash: byDept.marketing.payload_hash }, new Date()), { ok: false, error: "not_found" });
    assert.deepEqual(await store.decideApproval(raw, S.rep, byDept.finance.id, { kind: "send_back", note: "no" }, new Date()), { ok: false, error: "not_found" });
    assert.equal(await statusOf(byDept.marketing.id), "pending");
  });

  await check("personas: a read-only viewer who can see an approval cannot decide or comment on it", async () => {
    const ro: ApprovalScope = { ...S.cc, persona: "readonly", canAct: false };
    const d = await store.decideApproval(raw, ro, byDept.sales.id, { kind: "approve", payloadHash: byDept.sales.payload_hash }, new Date());
    assert.deepEqual(d, { ok: false, error: "forbidden" });
    assert.deepEqual(await store.commentOnApproval(raw, ro, byDept.sales.id, "hi", new Date()), { ok: false, error: "forbidden" });
    const [view] = await buildApprovalViews(raw, ro, [byDept.sales], { tenantSlug: "oasis-ai-cc", now: new Date(), deps: fakeDeps() });
    assert.deepEqual([view.can_decide, view.can_comment], [false, false]);
  });

  // ── 10. API routes (real session, real executors, dry-run) ─────────────
  const listRoute = await import("../app/api/approvals/route");
  const approveRoute = await import("../app/api/approvals/[id]/approve/route");
  const sendBackRoute = await import("../app/api/approvals/[id]/send-back/route");
  const commentRoute = await import("../app/api/approvals/[id]/comment/route");
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const nreq = (url: string) => {
    const r = req(url) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(url) });
    return r as never;
  };
  type Body = { ok: boolean; error?: string; approvals?: Array<{ id: string; title: string; tenant?: string }>; approval?: { status: string; execution_result: { outcome: string; message?: string } | null; decision_note: string | null; can_decide: boolean } };

  await check("GET /api/approvals: signed out 401; bad view/department 400", async () => {
    await login(null);
    assert.equal((await listRoute.GET(nreq("http://t.test/api/approvals"))).status, 401);
    await login("cc");
    assert.equal((await listRoute.GET(nreq("http://t.test/api/approvals?view=everything"))).status, 400);
    assert.equal((await listRoute.GET(nreq("http://t.test/api/approvals?department=hr"))).status, 400);
  });

  await check("GET /api/approvals: owner sees all four departments; rep only Sales; B none of A's", async () => {
    const titles = async (who: Who) => {
      await login(who);
      const res = await listRoute.GET(nreq("http://t.test/api/approvals?view=pending&limit=200"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as Body;
      return new Set(body.approvals!.map((a) => a.title));
    };
    const cc = await titles("cc");
    for (const t of ["SALES-MARKER", "MARKETING-MARKER", "FINANCE-MARKER", "UNATTRIBUTED-MARKER"]) assert.ok(cc.has(t), t);
    const rep = await titles("rep");
    assert.ok(rep.has("SALES-MARKER"));
    for (const t of ["MARKETING-MARKER", "FINANCE-MARKER", "UNATTRIBUTED-MARKER"]) assert.ok(!rep.has(t), `rep saw ${t}`);
    const client = await titles("clientOwner");
    for (const t of ["SALES-MARKER", "MARKETING-MARKER", "FINANCE-MARKER", "UNATTRIBUTED-MARKER", "OASIS-ONLY-MARKER"]) {
      assert.ok(!client.has(t), `client saw ${t}`);
    }
    const clientRep = await titles("clientRep");
    assert.ok(!clientRep.has("SALES-MARKER"), "a sales seat in B is not a sales seat in A");
  });

  await check("GET /api/approvals: ?limit= is a whole number in range whatever the query says (2.7, -5, abc)", async () => {
    await login("cc");
    const quiet = console.error;
    console.error = () => {};
    const sizes: Record<string, number> = {};
    try {
      for (const q of ["2.7", "-5", "abc"]) {
        const res = await listRoute.GET(nreq(`http://t.test/api/approvals?view=all&limit=${q}`));
        assert.equal(res.status, 200, `limit=${q} → ${res.status}`);
        sizes[q] = ((await res.json()) as Body).approvals!.length;
      }
    } finally {
      console.error = quiet;
    }
    assert.equal(sizes["2.7"], 2, "a fraction is truncated");
    assert.equal(sizes["-5"], 1, "a negative is the smallest page");
    assert.ok(sizes.abc > 2 && sizes.abc <= 50, `not a number → the default page (${sizes.abc})`);
    assert.deepEqual([store.listLimit(2.7), store.listLimit(-5), store.listLimit(Number.NaN), store.listLimit("abc"), store.listLimit(10_000)], [2, 1, 50, 50, store.APPROVAL_LIST_LIMIT]);
  });

  await check("POST approve: rep on Marketing's approval is 404 and nothing changes; B on A's is 404", async () => {
    await login("rep");
    const res = await approveRoute.POST(req("http://t.test", { payload_hash: byDept.marketing.payload_hash }) as never, ctx(byDept.marketing.id));
    assert.equal(res.status, 404);
    await login("clientOwner");
    const res2 = await approveRoute.POST(req("http://t.test", { payload_hash: byDept.sales.payload_hash }) as never, ctx(byDept.sales.id));
    assert.equal(res2.status, 404);
    assert.equal(await statusOf(byDept.marketing.id), "pending");
    assert.equal(await statusOf(byDept.sales.id), "pending");
  });

  await check("POST approve: wrong hash 409 payload_mismatch; bad JSON 400", async () => {
    await login("cc");
    const res = await approveRoute.POST(req("http://t.test", { payload_hash: sha("stale") }) as never, ctx(byDept.sales.id));
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as Body).error, "payload_mismatch");
    const bad = await approveRoute.POST(req("http://t.test", undefined, "{nope") as never, ctx(byDept.sales.id));
    assert.equal(bad.status, 400);
  });

  await check("POST approve: the rep approves Sales' email → 200 with the REAL outcome (dry run); the body cannot name the decider or tenant", async () => {
    await login("rep");
    const before = sent.length;
    const res = await approveRoute.POST(
      req("http://t.test", { payload_hash: byDept.sales.payload_hash, decided_by: USERS.cc.id, tenant_id: CLIENT }) as never,
      ctx(byDept.sales.id),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Body;
    assert.equal(body.approval?.status, "executed");
    assert.equal(body.approval?.execution_result?.outcome, "dry_run", "no live send flag set: dry run, honestly labelled");
    assert.equal(sent.length, before, "the fake mailbox is not wired into the route; the real one was never called");
    const row = (await raw.execute({ sql: "SELECT decided_by, tenant_id FROM approvals WHERE id = ?", args: [byDept.sales.id] })).rows[0];
    assert.deepEqual([row.decided_by, row.tenant_id], [USERS.rep.id, OASIS]);
    const ev = (await raw.execute({ sql: "SELECT event_type, publisher_agent, correlation_id, payload FROM agent_events WHERE payload LIKE ?", args: [`%${byDept.sales.id}%`] })).rows;
    assert.equal(ev.length, 1, "one tape row through the real publisher");
    assert.deepEqual([ev[0].event_type, ev[0].publisher_agent, ev[0].correlation_id], ["APPROVAL_DRY_RUN", "dept:sales", OASIS]);
    const again = await approveRoute.POST(req("http://t.test", { payload_hash: byDept.sales.payload_hash }) as never, ctx(byDept.sales.id));
    assert.equal(again.status, 409, "a second click is refused, not re-run");
  });

  await check("POST approve: five concurrent clicks — one decision, one execution, no error", async () => {
    const a = await create({ title: "RACE" });
    await login("cc");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => approveRoute.POST(req("http://t.test", { payload_hash: a.payload_hash }) as never, ctx(a.id))),
    );
    // A losing click either finds the row already moving (409) or resumes an
    // approved-not-started row (200, and the claim makes it a no-op).
    const statuses = results.map((r) => r.status);
    assert.ok(statuses.every((s) => s === 200 || s === 409), JSON.stringify(statuses));
    assert.ok(statuses.includes(200));
    const ev = await events(OASIS, a.id);
    assert.deepEqual(ev, ["created", "approved", "execution_started", "executed"]);
  });

  await check("POST approve resumes an approved row that never started, once; a stale hash cannot", async () => {
    const a = await create({ title: "STRANDED" });
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    const [stranded] = await buildApprovalViews(raw, S.cc, [(await store.getApproval(raw, S.cc, a.id))!], { tenantSlug: "oasis-ai-cc", now: new Date(), deps: fakeDeps() });
    assert.deepEqual([stranded.status, stranded.can_resume, stranded.can_decide], ["approved", true, false]);
    await login("cc");
    const stale = await approveRoute.POST(req("http://t.test", { payload_hash: sha("stale") }) as never, ctx(a.id));
    assert.equal(stale.status, 409);
    assert.equal(await statusOf(a.id), "approved");
    await login("rep");
    assert.equal((await approveRoute.POST(req("http://t.test", { payload_hash: a.payload_hash }) as never, ctx(a.id))).status, 200, "a sales seat may resume a sales approval");
    assert.equal(await statusOf(a.id), "executed");
    await login("cc");
    assert.equal((await approveRoute.POST(req("http://t.test", { payload_hash: a.payload_hash }) as never, ctx(a.id))).status, 409, "a finished row is not re-run");
    assert.deepEqual(await events(OASIS, a.id), ["created", "approved", "execution_started", "executed"]);
  });

  await check("POST send-back: no note 400 note_required; with a note 200 sent_back", async () => {
    await login("cc");
    const empty = await sendBackRoute.POST(req("http://t.test", { note: "  " }) as never, ctx(byDept.marketing.id));
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as Body).error, "note_required");
    const ok = await sendBackRoute.POST(req("http://t.test", { note: "Use the new pricing." }) as never, ctx(byDept.marketing.id));
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Body;
    assert.equal(body.approval?.status, "sent_back");
    assert.equal(body.approval?.decision_note, "Use the new pricing.");
    assert.equal(body.approval?.can_decide, false);
  });

  await check("POST comment: the owner comments (201); a worker who cannot see it gets 404", async () => {
    await login("cc");
    const res = await commentRoute.POST(req("http://t.test", { body: "Numbers look right." }) as never, ctx(byDept.finance.id));
    assert.equal(res.status, 201);
    await login("worker");
    const res2 = await commentRoute.POST(req("http://t.test", { body: "sneaky" }) as never, ctx(byDept.finance.id));
    assert.equal(res2.status, 404);
    const bodies = (await raw.execute({ sql: "SELECT meta FROM approval_events WHERE approval_id = ? AND event = 'commented'", args: [byDept.finance.id] })).rows.map((r) => JSON.parse(String(r.meta)).body);
    assert.deepEqual(bodies, ["Numbers look right."]);
  });

  await check("POST approve publish_post (OASIS founders tenant): queued through marketing_publish_intent, tenant-pinned", async () => {
    await raw.batch(
      [
        { sql: "INSERT INTO marketing_asset (id, tenant_id, title, status, brand_slug, asset_type) VALUES ('asset-1', ?, 'Reel', 'approved', 'oasis-ai', 'video')", args: [OASIS] },
        { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id) VALUES ('media-1', ?, 'asset-1')", args: [OASIS] },
      ],
      "write",
    );
    const assetHash = await publishHashOf(OASIS, "asset-1");
    const a = await create({ departmentKey: "marketing", actionKind: "publish_post", title: "Post the reel", payload: { asset_id: "asset-1", asset_hash: assetHash, platforms: ["instagram", "linkedin"], note: "Launch day" } });
    await login("marketer");
    const res = await approveRoute.POST(req("http://t.test", { payload_hash: a.payload_hash }) as never, ctx(a.id));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Body;
    assert.equal(body.approval?.status, "executed");
    assert.equal(body.approval?.execution_result?.outcome, "queued");
    const intents = (await raw.execute("SELECT tenant_id, asset_id, platforms, state, requested_by, note FROM marketing_publish_intent")).rows;
    assert.equal(intents.length, 1);
    assert.deepEqual(
      [intents[0].tenant_id, intents[0].asset_id, JSON.parse(String(intents[0].platforms)), intents[0].state, intents[0].requested_by, intents[0].note],
      [OASIS, "asset-1", ["instagram", "linkedin"], "queued", `approval:${a.id}`, "Launch day"],
    );
    // A second approved post of the same asset while the first is in flight is refused, not double-queued.
    const b = await create({ departmentKey: "marketing", actionKind: "publish_post", title: "Post it again", payload: { asset_id: "asset-1", asset_hash: assetHash, platforms: ["threads"] } });
    const quiet = console.error;
    console.error = () => {};
    try {
      const res2 = await approveRoute.POST(req("http://t.test", { payload_hash: b.payload_hash }) as never, ctx(b.id));
      const body2 = (await res2.json()) as Body;
      assert.equal(body2.approval?.status, "failed");
      assert.match(body2.approval?.execution_result?.message ?? "", /already in flight/);
    } finally {
      console.error = quiet;
    }
    assert.equal((await raw.execute("SELECT COUNT(*) AS n FROM marketing_publish_intent")).rows[0].n, 1);
  });

  await check("publish_post in a client workspace fails loudly: the publisher posts to OASIS's own accounts only", async () => {
    const r = await store.createApproval(
      raw,
      { tenantId: CLIENT, departmentKey: "marketing", requestedBy: { type: "agent", id: "maven" }, actionKind: "publish_post", title: "Client post", payload: { asset_id: "asset-1", asset_hash: sha("client asset"), platforms: ["instagram"] } },
      new Date(),
    );
    assert.ok(r.ok);
    await login("clientOwner");
    const quiet = console.error;
    console.error = () => {};
    try {
      const res = await approveRoute.POST(req("http://t.test", { payload_hash: r.approval.payload_hash }) as never, ctx(r.approval.id));
      const body = (await res.json()) as Body;
      assert.equal(body.approval?.status, "failed");
      assert.match(body.approval?.execution_result?.message ?? "", /OASIS's own accounts only/);
    } finally {
      console.error = quiet;
    }
    assert.equal((await raw.execute({ sql: "SELECT COUNT(*) AS n FROM marketing_publish_intent WHERE tenant_id = ?", args: [CLIENT] })).rows[0].n, 0);
  });

  /** A fresh own-brand OASIS asset with one video attached. */
  const insertPostAsset = async (assetId: string) =>
    raw.batch(
      [
        {
          sql: `INSERT INTO marketing_asset (id, tenant_id, title, status, brand_slug, format, asset_type, hook, body, cta, landing_url)
                VALUES (?, ?, 'Launch reel', 'approved', 'oasis-ai', 'video', 'video', 'Stop guessing', 'The caption the reviewer read.', 'book a call', 'https://oasisai.work')`,
          args: [assetId, OASIS],
        },
        { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_bucket, storage_path) VALUES (?, ?, ?, 'video', 'marketing-media', ?)", args: [`${assetId}-m`, OASIS, assetId, `${OASIS}/${assetId}/reel.mp4`] },
      ],
      "write",
    );
  /** An approved post of that asset, bound to its content as it is now. */
  const approvedPost = async (assetId: string, title: string) => {
    const a = await create({ departmentKey: "marketing", actionKind: "publish_post", title, payload: { asset_id: assetId, asset_hash: await publishHashOf(OASIS, assetId), platforms: ["instagram"] } });
    await store.decideApproval(raw, S.cc, a.id, { kind: "approve", payloadHash: a.payload_hash }, new Date());
    return a;
  };
  const intentsFor = async (assetId: string) =>
    Number((await raw.execute({ sql: "SELECT COUNT(*) AS n FROM marketing_publish_intent WHERE tenant_id = ? AND asset_id = ?", args: [OASIS, assetId] })).rows[0].n);

  await check("publish_post: an asset edited after approval (caption or media) is refused as asset_changed and nothing is queued", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const [assetId, edit] of [
        ["asset-edit-caption", "UPDATE marketing_asset SET body = 'A caption nobody approved.' WHERE tenant_id = ? AND id = ?"],
        ["asset-edit-media", "UPDATE marketing_asset_media SET storage_path = 'other/video.mp4' WHERE tenant_id = ? AND asset_id = ?"],
      ] as const) {
        await insertPostAsset(assetId);
        const a = await approvedPost(assetId, `Edited ${assetId}`);
        await raw.execute({ sql: edit, args: [OASIS, assetId] });
        const x = await executeApproval(raw, { tenantId: OASIS, approvalId: a.id }, fakeDeps());
        assert.ok(x.ok);
        assert.equal(x.approval.status, "failed", assetId);
        assert.equal((x.approval.execution_result as { reason: string }).reason, "asset_changed", assetId);
        assert.equal(await intentsFor(assetId), 0, `${assetId}: nothing queued`);
      }
    } finally {
      console.error = quiet;
    }
    // Unedited, the same path queues.
    await insertPostAsset("asset-unedited");
    const ok = await approvedPost("asset-unedited", "Unedited");
    const x = await executeApproval(raw, { tenantId: OASIS, approvalId: ok.id }, fakeDeps());
    assert.equal(x.ok && x.approval.execution_result?.outcome, "queued");
    assert.equal(await intentsFor("asset-unedited"), 1);
  });

  await check("exactly once: six approvals of the SAME asset executing concurrently queue ONE publish, the rest already_queued", async () => {
    await insertPostAsset("asset-race");
    // Six separate approvals (six people each said yes), one asset.
    const approvals = [];
    for (let i = 0; i < 6; i++) approvals.push(await approvedPost("asset-race", `Race ${i}`));
    const clients: Client[] = approvals.map(() => createClient({ url: `file:${dbFile}` }));
    const quiet = console.error;
    console.error = () => {};
    let results: Awaited<ReturnType<typeof executeApproval>>[];
    try {
      results = await Promise.all(
        approvals.map((a, i) =>
          executeApproval(clients[i], { tenantId: OASIS, approvalId: a.id }, fakeDeps({ marketingDb: () => createTursoPostgrest(clients[i]) as never, marketingSql: () => clients[i] })),
        ),
      );
    } finally {
      console.error = quiet;
    }
    const outcomes = results.map((r) => (r.ok ? (r.approval.execution_result as { outcome: string; reason?: string }) : null));
    assert.equal(outcomes.filter((o) => o?.outcome === "queued").length, 1, JSON.stringify(outcomes));
    assert.ok(outcomes.filter((o) => o?.outcome !== "queued").every((o) => o?.reason === "already_queued"), JSON.stringify(outcomes));
    assert.equal(await intentsFor("asset-race"), 1, "one intent: there is no unsending");
    for (const c of clients) c.close();
  });

  // ── 11. The agent tool proposes, never sends ───────────────────────────
  await check("propose_email: writes one pending approval in the SESSION's workspace, ignores a tenant in the input, sends nothing", async () => {
    const runner = await import("../lib/cloud-tool-runner");
    const clientCtx = { tenantId: CLIENT, userId: USERS.clientOwner.id, agentKey: "sdr", authUserId: USERS.clientOwner.id, isAdmin: true };
    const before = sent.length;
    const quiet = console.warn;
    console.warn = () => {};
    let first: { approval_id: string; sent: boolean; status: string; department: string; deduplicated: boolean };
    try {
      const r = await runner.executeTool(
        "propose_email",
        { to: "Prospect@Example.test", subject: "Quick question", body: "Do you have 15 minutes Thursday?", tenant_id: OASIS },
        clientCtx,
      );
      assert.equal(r.is_error, false, r.content);
      first = JSON.parse(r.content);
      assert.match(r.summary, /for approval \(not sent\)/);
    } finally {
      console.warn = quiet;
    }
    assert.deepEqual([first.sent, first.status, first.department, first.deduplicated], [false, "pending", "sales", false]);
    const row = (await raw.execute({ sql: "SELECT tenant_id, requested_by_type, requested_by_id, action_kind, payload_json FROM approvals WHERE id = ?", args: [first.approval_id] })).rows[0];
    assert.deepEqual([row.tenant_id, row.requested_by_type, row.requested_by_id, row.action_kind], [CLIENT, "agent", "sdr", "send_email"]);
    assert.equal(JSON.parse(String(row.payload_json)).to, "prospect@example.test");
    assert.equal(sent.length, before, "a proposal sends nothing");
    const retry = JSON.parse((await runner.executeTool("propose_email", { to: "prospect@example.test", subject: "Quick question", body: "Do you have 15 minutes Thursday?" }, clientCtx)).content);
    assert.deepEqual([retry.approval_id, retry.deduplicated], [first.approval_id, true], "a retried call returns the same card");
    const bad = await runner.executeTool("propose_email", { to: "nope", subject: "s", body: "b" }, clientCtx);
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /to_invalid/);

    // Sent back → the agent reads the note → revises as v2.
    await store.decideApproval(raw, S.clientOwner, first.approval_id, { kind: "send_back", note: "Offer two times." }, new Date());
    const listed = JSON.parse((await runner.executeTool("list_proposals", { view: "decided" }, clientCtx)).content);
    const mine = listed.proposals.find((p: { approval_id: string }) => p.approval_id === first.approval_id);
    assert.deepEqual([mine.status, mine.reviewer_note], ["sent_back", "Offer two times."]);
    const v2 = JSON.parse(
      (await runner.executeTool("propose_email", { to: "prospect@example.test", subject: "Quick question", body: "Thursday 10:00 or 14:00?", revises_approval_id: first.approval_id }, clientCtx)).content,
    );
    assert.equal(v2.revision, 2);

    // Another agent in the same workspace cannot withdraw that card by "revising" it.
    const other = await runner.executeTool(
      "propose_email",
      { to: "prospect@example.test", subject: "Mine now", body: "Different words.", revises_approval_id: v2.approval_id },
      { ...clientCtx, agentKey: "maven" },
    );
    assert.equal(other.is_error, true);
    assert.match(other.content, /supersedes_not_yours/);
    const still = (await raw.execute({ sql: "SELECT status FROM approvals WHERE tenant_id = ? AND id = ?", args: [CLIENT, v2.approval_id] })).rows[0];
    assert.equal(still.status, "pending", "the owner agent's card is untouched");
    const missing = await runner.executeTool(
      "propose_email",
      { to: "prospect@example.test", subject: "S", body: "B", revises_approval_id: "nope" },
      clientCtx,
    );
    assert.match(missing.content, /supersedes_not_found/);

    // list_proposals through a NON-admin member: the owner-only departments'
    // cards (Finance here) stay out, exactly as on every screen; an admin reads them.
    const fin = JSON.parse(
      (await runner.executeTool("propose_email", { to: "books@example.test", subject: "Invoice 42 is overdue", body: "Reminder.", department: "finance" }, clientCtx)).content,
    );
    assert.equal(fin.department, "finance");
    const memberCtx = { ...clientCtx, userId: USERS.clientRep.id, authUserId: USERS.clientRep.id, isAdmin: false };
    const asMember = JSON.parse((await runner.executeTool("list_proposals", {}, memberCtx)).content) as { proposals: Array<{ approval_id: string; department: string | null }> };
    assert.ok(!asMember.proposals.some((p) => p.approval_id === fin.approval_id), "a member does not read a Finance card through the agent");
    assert.ok(asMember.proposals.some((p) => p.approval_id === v2.approval_id), "a member still reads the agent's Sales cards");
    assert.ok(asMember.proposals.every((p) => p.department === "sales" || p.department === "marketing" || p.department === "client_success"));
    const asAdmin = JSON.parse((await runner.executeTool("list_proposals", {}, clientCtx)).content) as { proposals: Array<{ approval_id: string }> };
    assert.ok(asAdmin.proposals.some((p) => p.approval_id === fin.approval_id), "an owner/admin reads every department");
  });

  // The agent works for CLIENT's owner in the checks below unless it says otherwise.
  const agentCtx = { tenantId: CLIENT, userId: USERS.clientOwner.id, agentKey: "sdr", authUserId: USERS.clientOwner.id, isAdmin: true };
  type Proposal = { approval_id: string; status: string; department: string | null; reviewer_note: string | null; outcome: Record<string, unknown> | null };
  const proposeAs = async (input: Record<string, unknown>, c: typeof agentCtx = agentCtx) => {
    const runner = await import("../lib/cloud-tool-runner");
    return runner.executeTool("propose_email", input, c);
  };
  const listAs = async (input: Record<string, unknown>, c: typeof agentCtx = agentCtx) => {
    const runner = await import("../lib/cloud-tool-runner");
    const r = await runner.executeTool("list_proposals", input, c);
    assert.equal(r.is_error, false, r.content);
    return { content: r.content, proposals: (JSON.parse(r.content) as { proposals: Proposal[] }).proposals };
  };

  await check("list_proposals: a member's agent reads back only the departments that member may decide (rep: Sales; worker: Client Success)", async () => {
    const card = async (department: string) => JSON.parse((await proposeAs({ to: "seat@example.test", subject: `Seat: ${department}`, body: "Seat check.", department })).content) as { approval_id: string };
    const cards = { sales: await card("sales"), marketing: await card("marketing"), client_success: await card("client_success"), finance: await card("finance") };
    const as = (who: "clientRep" | "clientWorker") => ({ ...agentCtx, userId: USERS[who].id, authUserId: USERS[who].id, isAdmin: false });
    const rep = (await listAs({ view: "all", limit: 50 }, as("clientRep"))).proposals;
    assert.deepEqual([...new Set(rep.map((p) => p.department))], ["sales"], "a rep reads Sales only");
    assert.ok(rep.some((p) => p.approval_id === cards.sales.approval_id));
    const worker = (await listAs({ view: "all", limit: 50 }, as("clientWorker"))).proposals;
    assert.deepEqual([...new Set(worker.map((p) => p.department))], ["client_success"], "a delivery worker reads Client Success only");
    assert.ok(worker.some((p) => p.approval_id === cards.client_success.approval_id));
    // Someone with no profile in this workspace is not "a member who sees nothing": the read refuses.
    const runner = await import("../lib/cloud-tool-runner");
    const stranger = await runner.executeTool("list_proposals", {}, { ...agentCtx, userId: USERS.rep.id, authUserId: USERS.rep.id, isAdmin: false });
    assert.equal(stranger.is_error, true);
    assert.match(stranger.content, /approvals_unavailable/);
  });

  await check("list_proposals: a pending card past its expiry is reported expired, the way every card shows it", async () => {
    const r = await store.createApproval(
      raw,
      { tenantId: CLIENT, departmentKey: "sales", requestedBy: { type: "agent", id: "sdr" }, actionKind: "send_email", title: "Waited too long", payload: email("late@example.test", "Too late"), expiresAt: new Date(Date.now() - 60_000).toISOString() },
      new Date(Date.now() - 120_000),
    );
    assert.ok(r.ok);
    assert.equal(await statusOf(r.approval.id), "pending", "nothing has written the expiry yet");
    const mine = (await listAs({ view: "all", limit: 50 })).proposals.find((p) => p.approval_id === r.approval.id);
    assert.equal(mine?.status, "expired");
  });

  await check("list_proposals: a configured secret in a reviewer's note or a recorded outcome never reaches the model", async () => {
    const noted = JSON.parse((await proposeAs({ to: "leak@example.test", subject: "Redaction: note", body: "Hello." })).content) as { approval_id: string };
    await store.decideApproval(raw, S.clientOwner, noted.approval_id, { kind: "send_back", note: `Put ${CANARY_SECRET} in the footer.` }, new Date());
    const failed = JSON.parse((await proposeAs({ to: "leak@example.test", subject: "Redaction: outcome", body: "Hello." })).content) as { approval_id: string };
    await raw.execute({
      sql: "UPDATE approvals SET status = 'failed', execution_result = ? WHERE tenant_id = ? AND id = ?",
      args: [JSON.stringify({ outcome: "failed", reason: "send_failed", message: `The mail server refused it: bad key ${CANARY_SECRET}`, provider: "x" }), CLIENT, failed.approval_id],
    });
    const { content, proposals } = await listAs({ view: "all", limit: 50 });
    assert.ok(!content.includes(CANARY_SECRET), "a configured secret reached the model");
    assert.match(proposals.find((p) => p.approval_id === noted.approval_id)?.reviewer_note ?? "", /Put \[REDACTED:OS_APPROVALS_CANARY_API_KEY\] in the footer/);
    assert.match(String(proposals.find((p) => p.approval_id === failed.approval_id)?.outcome?.message), /bad key \[REDACTED:OS_APPROVALS_CANARY_API_KEY\]/);
  });

  await check("revision retry: the same key and words return the revision already made; other words under that key are refused", async () => {
    const a = await create();
    const input = {
      tenantId: OASIS,
      departmentKey: "sales" as const,
      requestedBy: { type: "agent" as const, id: "sdr" },
      actionKind: "send_email" as const,
      title: "Retried v2",
      payload: email("x@y.test", "Retried subject"),
      supersedesId: a.id,
      idempotencyKey: `rev-retry-${a.id}`,
    };
    const first = await store.createApproval(raw, input, new Date());
    assert.ok(first.ok && first.created);
    const retry = await store.createApproval(raw, input, new Date());
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.deepEqual([retry.created, retry.approval.id, retry.approval.revision], [false, first.approval.id, 2]);
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await store.createApproval(raw, { ...input, payload: email("x@y.test", "Other words") }, new Date()), { ok: false, error: "idempotency_key_reused" });
    } finally {
      console.error = quiet;
    }
    const otherKey = await store.createApproval(raw, { ...input, idempotencyKey: `rev-other-${a.id}` }, new Date());
    assert.deepEqual(otherKey, { ok: false, error: "already_revised", successorId: first.approval.id });
    assert.equal((await raw.execute({ sql: "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND supersedes_id = ?", args: [OASIS, a.id] })).rows[0].n, 1);

    // Through the agent tool: a model that retries its revision gets the same card back.
    const v1 = JSON.parse((await proposeAs({ to: "retry@example.test", subject: "Retry v1", body: "One." })).content) as { approval_id: string };
    await store.decideApproval(raw, S.clientOwner, v1.approval_id, { kind: "send_back", note: "Shorter." }, new Date());
    const revise = { to: "retry@example.test", subject: "Retry v2", body: "Two.", revises_approval_id: v1.approval_id };
    const r1 = await proposeAs(revise);
    const r2 = await proposeAs(revise);
    assert.equal(r2.is_error, false, r2.content);
    assert.deepEqual([JSON.parse(r2.content).approval_id, JSON.parse(r2.content).deduplicated], [JSON.parse(r1.content).approval_id, true]);
  });

  await check("propose_email: an agent with no key cannot revise a draft, not even another keyless one", async () => {
    const keyless = { ...agentCtx, agentKey: "" };
    const orphan = JSON.parse((await proposeAs({ to: "orphan@example.test", subject: "Keyless", body: "One." }, keyless)).content) as { approval_id: string };
    const row = (await raw.execute({ sql: "SELECT requested_by_id FROM approvals WHERE tenant_id = ? AND id = ?", args: [CLIENT, orphan.approval_id] })).rows[0];
    assert.equal(row.requested_by_id, null, "a keyless agent's card has no owner id");
    const revise = await proposeAs({ to: "orphan@example.test", subject: "Keyless v2", body: "Two.", revises_approval_id: orphan.approval_id }, keyless);
    assert.equal(revise.is_error, true);
    assert.match(revise.content, /supersedes_not_yours/);
    assert.equal(await statusOf(orphan.approval_id), "pending", "the card is untouched");
  });

  await check("propose_email and list_proposals are client-safe, never deferred, denied to read-only, stripped in plan mode", async () => {
    const runner = await import("../lib/cloud-tool-runner");
    const registry = await import("../lib/ai/tools/client-safe-registry");
    const { READ_ONLY_DENIED_TOOLS } = await import("../lib/role-gates");
    const { PLAN_MODE_TOOL_ALLOWLIST } = await import("../lib/chat-modes/plan-mode");
    const { SAFE_TENANT_TOOL_PALETTE } = await import("../lib/chat-tool-palettes");
    for (const [name, cls] of [["propose_email", "draft"], ["list_proposals", "read"]] as const) {
      const def = runner.TOOL_DEFINITIONS.find((t) => t.name === name);
      assert.ok(def, `${name} is defined`);
      assert.ok(!def.defer, `${name} runs in the cloud, never on the paired machine`);
      assert.equal(registry.CLIENT_SAFE_TOOLS.get(name), cls);
      assert.ok(SAFE_TENANT_TOOL_PALETTE.includes(name), `${name} is in the safe default palette`);
    }
    assert.equal(READ_ONLY_DENIED_TOOLS.has("propose_email"), true);
    assert.equal(PLAN_MODE_TOOL_ALLOWLIST.has("propose_email"), false, "plan mode proposes nothing");
    assert.equal(PLAN_MODE_TOOL_ALLOWLIST.has("list_proposals"), true, "reading its own cards is research");
    const src = readFileSync(join(ROOT, "lib/cloud-tool-runner.ts"), "utf8");
    const body = src.slice(src.indexOf("async function toolProposeEmail"), src.indexOf("async function toolListProposals"));
    assert.ok(body.length > 200, "found toolProposeEmail");
    for (const banned of ["sendOasisSharedGmail", "executeApproval", "decideApproval", "exec-tool", "sendGmail"]) {
      assert.ok(!body.includes(banned), `propose_email must not reach ${banned}`);
    }
  });

  // ── 12. Surfaces ───────────────────────────────────────────────────────
  await check("Feed: the owner lands on Needs you with live approval cards; a rep sees only the departments they sit in", async () => {
    const FeedPage = (await import("../app/feed/page")).default;
    const { ApprovalCard } = await import("../components/os/approvals/ApprovalCard");
    await login("cc");
    const tree = await FeedPage({ searchParams: Promise.resolve({}) });
    const found = walk(tree);
    const cards = found.elements.filter((e) => e.type === ApprovalCard).map((e) => (e.props.approval as { title: string; status: string }));
    assert.ok(cards.some((c) => c.title === "FINANCE-MARKER" && c.status === "pending"), "pending cards render");
    assert.ok(cards.some((c) => c.title === "SALES-MARKER" && c.status === "executed"), "recently decided shows the real outcome");
    assert.ok(!cards.some((c) => c.title === "Client post" || c.title === "Client email"), "no other workspace's cards");
    const tabs = found.elements.find((e) => e.props && "active" in e.props && "counts" in e.props);
    assert.equal(tabs?.props.active, "needs", "opens on Needs you when something waits");
    // Every persona has the Feed since #469 (lib/role-surfaces.ts), so the
    // rep's page renders; what it must not do is show a card from a
    // department the rep is not seated in (rules.ts DEPARTMENT_SEATS).
    await login("rep");
    const repTree = await FeedPage({ searchParams: Promise.resolve({ tab: "needs" }) });
    const repCards = walk(repTree)
      .elements.filter((e) => e.type === ApprovalCard)
      .map((e) => e.props.approval as { title: string; department_key: string | null });
    assert.ok(repCards.length > 0, "the rep sees Sales' cards");
    assert.ok(
      repCards.every((c) => c.department_key === "sales"),
      `a rep saw another department's card: ${repCards.map((c) => `${c.title}/${c.department_key}`).join(", ")}`,
    );
    assert.ok(!repCards.some((c) => c.title === "FINANCE-MARKER" || c.title === "MARKETING-MARKER"));
  });

  await check("Feed: when more decisions exist than it shows, it says so instead of implying the list is complete", async () => {
    const FeedPage = (await import("../app/feed/page")).default;
    const decided = await store.listApprovals(raw, S.cc, { view: "decided", limit: 200 }, new Date());
    assert.ok(decided.rows.length > 20, `needs more than one page of decisions; has ${decided.rows.length}`);
    await login("cc");
    const text = walk(await FeedPage({ searchParams: Promise.resolve({ tab: "needs" }) })).strings.join(" ");
    assert.match(text, /Showing the latest\s+20\s+decisions from the last 7 days/);
  });

  await check("Overview panel and Today render the cards, a failed read says so, and the placeholders are gone", async () => {
    const { OverviewPanel } = await import("../components/os/department/OverviewPanel");
    const { NeedsYouList } = await import("../components/os/today/NeedsYouList");
    const { buildNeedsYou, buildDepartmentCards } = await import("../components/os/today/model");
    const { ApprovalCard } = await import("../components/os/approvals/ApprovalCard");
    const [view] = await buildApprovalViews(raw, S.cc, [byDept.finance], { tenantSlug: "oasis-ai-cc", now: new Date(), deps: fakeDeps() });
    const base = { attention: [], tiles: [], routines: { ok: true as const, value: [] }, connections: [], canManageConnections: true, asks: [] };
    const panel = walk(OverviewPanel({ ...base, approvals: { ok: true, value: { items: [view], total: 4 } }, feedHref: "/feed?tab=needs&dept=finance" }));
    assert.equal(panel.elements.filter((e) => e.type === ApprovalCard).length, 1);
    assert.ok(panel.strings.join("").includes("All 4 in Feed"));
    const failed = walk(OverviewPanel({ ...base, approvals: { ok: false }, feedHref: null })).strings.join(" ");
    assert.match(failed, /Couldn’t load approvals/);
    assert.doesNotMatch(failed, /Nothing is waiting/, "a failed read is not 'nothing waiting'");
    const empty = walk(OverviewPanel({ ...base, approvals: { ok: true, value: { items: [], total: 0 } }, feedHref: null })).strings.join(" ");
    assert.match(empty, /Nothing is waiting on you/);

    const needs = buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, approvals: { ok: true, value: { items: [view], total: 7 } }, nowMs: Date.now() });
    const list = walk(NeedsYouList({ needsYou: needs, feedHref: "/feed?tab=needs" }));
    assert.equal(list.elements.filter((e) => e.type === ApprovalCard).length, 1);
    assert.ok(list.strings.includes("7"), "the count includes every waiting approval");
    assert.ok(list.strings.join("").includes("All 7 approvals in Feed"));
    const gaps = buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, approvals: { ok: false }, nowMs: Date.now() });
    assert.deepEqual(gaps.unavailable, ["approvals"]);
    const cards = buildDepartmentCards({ departments: [{ key: "chief_of_staff", label: "Chief of Staff", href: "/team/chief-of-staff" }], needsYou: needs, sales: null, delivery: null, content: null, goal: null, stripeConnected: null });
    assert.equal(cards[0].status, "7 waiting on you", "Chief of Staff counts approvals too");

    for (const [file, placeholder] of [
      ["components/os/department/OverviewPanel.tsx", "Approvals arrive here"],
      ["components/os/landings/FeedView.tsx", "Approvals arrive with department channels"],
      ["components/os/today/NeedsYouList.tsx", "There are no approval cards yet"],
    ] as const) {
      assert.ok(!readFileSync(join(ROOT, file), "utf8").includes(placeholder), `${file} still says "${placeholder}"`);
    }
  });

  // ── 13. Static guards ──────────────────────────────────────────────────
  await check("static: approval_events is append-only; every approvals statement is tenant-pinned; routes never read a tenant from the body", () => {
    const code = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const storeSrc = code("lib/os/approvals/store.ts");
    assert.doesNotMatch(storeSrc, /UPDATE\s+approval_events|DELETE\s+FROM\s+approval_events/i);
    assert.doesNotMatch(storeSrc, /DELETE\s+FROM\s+approvals/i, "approvals are never deleted by the app");
    const sqls = storeSrc.match(/`[^`]*\b(?:FROM|UPDATE|INTO)\s+approvals\b[^`]*`/g) ?? [];
    assert.ok(sqls.length >= 8, `found ${sqls.length} approvals statements`);
    for (const s of sqls) assert.match(s, /tenant_id/, `not tenant-pinned: ${s.slice(0, 120)}`);
    for (const f of [
      "app/api/approvals/route.ts",
      "app/api/approvals/[id]/approve/route.ts",
      "app/api/approvals/[id]/send-back/route.ts",
      "app/api/approvals/[id]/comment/route.ts",
    ]) {
      const src = code(f);
      assert.match(src, /resolveApprovalSession\(\)/, `${f} resolves the session`);
      assert.doesNotMatch(src, /body\.(tenant|decided_by|user)|tenant_id/, `${f} reads identity from the request`);
    }
  });

  await check("static: every surface reads approvals only after its own gate, scoped by the rail's inputs", () => {
    const code = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const dept = code("app/team/[dept]/page.tsx");
    const gate = dept.indexOf("departmentGate(slug, viewer.navInput)");
    assert.ok(gate > 0 && dept.indexOf("loadPendingApprovals(") > gate, "department approvals load after the gate");
    assert.match(dept, /approvalScopeFromViewer\(\{ surface: viewer\.surface, navInput: viewer\.navInput \}\)/);
    const feed = code("app/feed/page.tsx");
    assert.ok(feed.indexOf('requireOsRoute("/feed")') < feed.indexOf("loadPendingApprovals("), "the Feed gates first");
    assert.match(code("components/today/FounderToday.tsx"), /loadPendingApprovals\(\{\s*scope: approvalScopeFromViewer\(\{ surface: viewer, navInput \}\)/);
  });

  await check("static: the approval surfaces carry no gradient, glow or perpetual animation", () => {
    for (const f of [
      "components/os/approvals/ApprovalCard.tsx",
      "components/os/today/NeedsYouList.tsx",
      "components/os/department/OverviewPanel.tsx",
      "app/feed/page.tsx",
    ]) {
      assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /bg-gradient|from-\w+-\d+ to-|shadow-\[0_0_|animate-(pulse|ping|spin|bounce)|drop-shadow|bg-clip-text/, f);
    }
  });

  console.log(`os-approvals: ${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
