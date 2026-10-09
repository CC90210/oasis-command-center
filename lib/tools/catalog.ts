/**
 * lib/tools/catalog.ts - which tool cards a workspace sees, and in what state.
 * The page passes this to the grid; there is no separate route.
 *
 *   score_hook        always ready (no AI, no network)
 *   repurpose_post,   ready on a usable workspace AI account (switched on, a
 *   learn_from_link   key, not a local model server); otherwise the card says
 *                     to connect one, or that the account could not be read
 *   video_download    ONLY while a runner that serves this workspace and lists
 *                     the tool was seen in the last 10 minutes; otherwise no
 *                     card at all (no button that cannot work)
 *
 * Not installed (migration bravo__206 not applied, or no database): the grid
 * shows one line and nothing else. Every card that is shown works end to end.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { readWorkspaceAiAccount, type WorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { TOOL_REGISTRY } from "@/lib/tools/registry";
import { liveRunnersFor, toolTablesInstalled } from "@/lib/tools/store";
import type { CatalogTool, CatalogToolState, ToolCatalog } from "@/lib/tools/types";
import { accountState } from "@/lib/tools/worker/ai";

export type { CatalogTool, CatalogToolState, ToolCatalog };

export type CatalogDeps = {
  db?: Client;
  now?: Date;
  readAccount?: (tenantId: string) => Promise<WorkspaceAiAccount | null>;
};

export async function getToolCatalog(viewer: { tenantId: string }, deps: CatalogDeps = {}): Promise<ToolCatalog> {
  if (!deps.db && !tursoConfigured()) return { installed: false };
  const db = deps.db ?? getTursoClient();
  const now = deps.now ?? new Date();
  if (!(await toolTablesInstalled(db))) return { installed: false };

  const needsAccount = TOOL_REGISTRY.some((t) => t.needsAiAccount);
  const readAccount = deps.readAccount ?? readWorkspaceAiAccount;
  const [aiState, runners] = await Promise.all([
    needsAccount
      ? readAccount(viewer.tenantId).then(
          (a): CatalogToolState => accountState(a),
          (err): CatalogToolState => {
            console.error("[tools.catalog.account]", { tenantId: viewer.tenantId, error: err instanceof Error ? err.message : String(err) });
            return "ai_account_unreadable";
          },
        )
      : Promise.resolve<CatalogToolState>("ready"),
    liveRunnersFor(db, viewer.tenantId, now),
  ]);

  const tools: CatalogTool[] = [];
  for (const t of TOOL_REGISTRY) {
    const base = { key: t.key, title: t.title, description: t.description, runLabel: t.runLabel, runsOn: t.runsOn, fields: t.fields };
    if (t.runsOn === "runner") {
      const runner = runners.find((r) => r.tools.includes(t.key));
      if (!runner) continue;
      const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(runner.lastSeenAt)) / 60_000));
      tools.push({ ...base, state: "ready", runner: { label: runner.label, lastSeenMinutes: minutes } });
      continue;
    }
    tools.push({ ...base, state: t.needsAiAccount ? aiState : "ready" });
  }
  return { installed: true, tools };
}
