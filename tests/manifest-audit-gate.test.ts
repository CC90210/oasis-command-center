/**
 * A workspace's manifest change log is readable by that workspace and by
 * platform operators only.
 *
 * WHY. GET /api/manifest/<slug>/audit checked only that SOME session existed,
 * then returned the slug's last 50 change-log rows (diffs, messages, actor
 * ids). Its comment trusted a row-level-security policy to narrow the rows to
 * the caller's tenant, but Turso has no RLS, so any signed-in user of any
 * workspace could read another workspace's change log by its slug, and slugs
 * are public in /f/<slug>/ form links (2026-10-19 audit). It now uses the
 * same gate as GET /api/manifest/<slug>: resolveCallerTenantAccess +
 * canPreviewTenantSlug, with one 404 for "not yours" and "does not exist".
 *
 * The REAL route handler and the REAL canPreviewTenantSlug run. Only the
 * caller lookup (which needs a session and a database) and the manifest reads
 * are stand-ins, injected through require.cache before the route loads.
 *
 * Run: node --conditions=react-server --import tsx tests/manifest-audit-gate.test.ts
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";

type Access = { isPlatformOperator?: boolean; tenant_slug?: string | null; command_center_profile_slug?: string | null } | null;

const SECRET = "CHANGE-LOG-ROW-DO-NOT-LEAK";
let caller: Access = null;
const reads: string[] = [];

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeJS.Module;
}

async function main() {
  // lib/tenant-access imports next/navigation for its page guard, and the real
  // one loads the client router context, which does not exist under
  // react-server (the same stand-in tests/admin-surfaces-operator-only.test.ts
  // uses). Nothing here renders a page, so neither is called.
  stub("next/navigation", {
    notFound: () => {
      throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    },
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT;${url}`);
    },
  });
  stub("next/headers", {
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
    headers: async () => new Headers(),
  });
  // A session exists whenever a caller does. The route no longer asks for the
  // bare session, but the version that leaked did, and with this stand-in it
  // runs to the end and fails the cross-workspace check for the right reason.
  stub("../lib/supabase-server", {
    getSessionUser: async () => (caller ? { id: "user-1", email: "user@example.test" } : null),
    getServiceSupabase: () => {
      throw new Error("no database in this test");
    },
  });
  // The real gate, taken before its module is replaced: canPreviewTenantSlug is
  // pure, so the copy is the function production runs.
  const realAccess = await import("../lib/tenant-access");
  const canPreviewTenantSlug = realAccess.canPreviewTenantSlug;
  delete require.cache[require.resolve("../lib/tenant-access")];
  stub("../lib/tenant-access", {
    canPreviewTenantSlug,
    resolveCallerTenantAccess: async () => caller,
  });
  stub("../lib/manifest/loader", {
    manifestExists: async (slug: string) => slug === "oasis-ai-cc" || slug === "client-co",
  });
  stub("../lib/manifest/persistence", {
    getManifestRow: async (slug: string) => {
      reads.push(`row:${slug}`);
      return { id: `manifest-${slug}` };
    },
    listManifestAudit: async (id: string) => {
      reads.push(`audit:${id}`);
      return [{ id: "a1", manifest_id: id, message: SECRET }];
    },
  });

  const { GET } = await import("../app/api/manifest/[slug]/audit/route");
  const { NextRequest } = await import("next/server");
  const call = (slug: string) =>
    GET(new NextRequest(`http://localhost/api/manifest/${slug}/audit`), { params: Promise.resolve({ slug }) });

  let failures = 0;
  async function check(name: string, fn: () => Promise<void>) {
    reads.length = 0;
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failures += 1;
      console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    }
  }

  console.log("manifest-audit-gate:");

  await check("signed out: 401, and nothing is read", async () => {
    caller = null;
    const res = await call("oasis-ai-cc");
    assert.equal(res.status, 401);
    assert.deepEqual(reads, []);
  });

  await check("another workspace's user: 404, no change-log row, nothing read", async () => {
    caller = { isPlatformOperator: false, tenant_slug: "client-co" };
    const res = await call("oasis-ai-cc");
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET), "the change log leaked across workspaces");
    assert.deepEqual(reads, []);
  });

  await check("'not yours' and 'does not exist' answer the same 404", async () => {
    caller = { isPlatformOperator: false, tenant_slug: "client-co" };
    const theirs = await call("oasis-ai-cc");
    const nobody = await call("no-such-workspace");
    assert.equal(theirs.status, 404);
    assert.equal(nobody.status, 404);
    assert.deepEqual(await theirs.json(), await nobody.json());
  });

  await check("a user with no workspace yet: 404", async () => {
    caller = { isPlatformOperator: false, tenant_slug: null };
    assert.equal((await call("oasis-ai-cc")).status, 404);
  });

  await check("the workspace's own user reads its change log", async () => {
    caller = { isPlatformOperator: false, tenant_slug: "client-co" };
    const res = await call("client-co");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ message: string }>; manifest_id: string };
    assert.equal(body.manifest_id, "manifest-client-co");
    assert.equal(body.entries[0]?.message, SECRET);
  });

  await check("the workspace reached by its command-center profile slug reads it too", async () => {
    caller = { isPlatformOperator: false, tenant_slug: "other", command_center_profile_slug: "client-co" };
    assert.equal((await call("client-co")).status, 200);
  });

  await check("a platform operator reads any workspace's change log", async () => {
    caller = { isPlatformOperator: true, tenant_slug: "oasis-ai-cc" };
    assert.equal((await call("client-co")).status, 200);
  });

  await check("a malformed slug is a 400 before any lookup", async () => {
    caller = { isPlatformOperator: true };
    assert.equal((await call("../etc")).status, 400);
    assert.deepEqual(reads, []);
  });

  if (failures > 0) {
    console.log(`manifest-audit-gate: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("manifest-audit-gate: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
