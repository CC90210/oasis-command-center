/**
 * Read-only live smoke test for Founders -> Finances: runs every page's data
 * loader against the PRODUCTION books exactly as the pages do, and prints how
 * long each took plus the figures a founder should see. Writes nothing (the
 * overview's overdue sweep is skipped via its page opt-out when available).
 *
 *   node --conditions=react-server --import tsx scripts/finance-live-smoke.ts
 */

import { dirname } from "node:path";
import { loadEnvConfig } from "@next/env";

process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
loadEnvConfig(process.cwd());

// next/navigation pulls the client router context (React.createContext), which
// does not exist under the react-server condition; the loaders only need
// notFound. Same stub as tests/finances-roundtrips.test.ts.
{
  const path = require.resolve("next/navigation");
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      notFound: () => {
        throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
      },
    },
  } as unknown as NodeModule;
}

const CC_EMAIL = "conaugh@oasisai.work";

async function main() {
  const { tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const pc = await import("../lib/founders-finances/page-context");

  const profile = await getServiceSupabase()
    .from("user_profiles")
    .select("auth_user_id")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("email", CC_EMAIL)
    .maybeSingle();
  const userId = (profile.data as { auth_user_id?: string } | null)?.auth_user_id;
  if (!userId) throw new Error("cc_profile_not_found");
  const viewer = { kind: "founder" as const, ownerKey: "cc" as const, email: CC_EMAIL, userId };
  const entity = await pc.financeBook(viewer);
  console.log(`book: ${entity.name} (${entity.kind})`);

  const sp = {} as Record<string, string>;
  const pages: Array<[string, () => Promise<unknown>]> = [
    ["overview", () => pc.loadOverviewPage(viewer, entity)],
    ["transactions", () => pc.loadTransactionsPage(viewer, entity, sp)],
    ["invoices", () => pc.loadInvoicesPage(viewer, entity, sp)],
    ["bills", () => pc.loadBillsPage(viewer, entity)],
    ["accounts", () => pc.loadAccountsPage(viewer, entity)],
    ["reports", () => pc.loadReportsPage(viewer, entity, sp)],
    ["taxes", () => pc.loadTaxesPage(viewer, sp)],
    ["settings", () => pc.loadSettingsPage(viewer, entity)],
  ];
  let failed = 0;
  for (const [name, load] of pages) {
    const t0 = performance.now();
    try {
      const data = await load();
      const ms = Math.round(performance.now() - t0);
      console.log(`ok   ${name.padEnd(13)} ${String(ms).padStart(5)} ms  ${JSON.stringify(data).length} bytes`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name.padEnd(13)} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
