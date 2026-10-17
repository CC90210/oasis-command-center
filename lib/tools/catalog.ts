/**
 * lib/tools/catalog.ts - which tool cards a workspace sees, and in what state.
 * The page passes this to the grid; there is no separate route.
 *
 *   video_download    "Video extractor", the page's first tool: ready while a
 *                     runner that serves this workspace and lists the tool was
 *                     seen in the last 10 minutes (CMO-Agent
 *                     scripts/content_tools_runner.py, every minute on OASIS's
 *                     PC); otherwise runner_offline: the card says the PC is
 *                     offline, keeps its past runs and their downloads, and
 *                     offers no Run button
 *   repurpose_post    ready on a usable workspace AI account; left off the
 *                     Content Tools page since 2026-10-17 (CONTENT_TOOLS_HIDDEN)
 *   learn_from_link   the same account rule, but OASIS-operators-only: it never
 *                     appears in the default ("client") audience below, only
 *                     in the "operator" one (Admin > Agent training)
 *
 * Not installed (migration bravo__206 not applied, or no database): the grid
 * shows one line and nothing else. No card offers a button that cannot work.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { OASIS_INTERNAL_TENANT_IDS } from "@/lib/ai/tools/client-safe-registry";
import { readWorkspaceAiAccount, type WorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { TOOL_REGISTRY } from "@/lib/tools/registry";
import { liveRunnersFor, toolTablesInstalled } from "@/lib/tools/store";
import type { CatalogTool, CatalogToolState, ToolCatalog } from "@/lib/tools/types";
import { accountState } from "@/lib/tools/worker/ai";

export type { CatalogTool, CatalogToolState, ToolCatalog };

/**
 * Kept in the registry, left off the Content Tools page (the "client" audience).
 * repurpose_post, 2026-10-17: CC asked for the page to lead with the video
 * extractor, and Repurpose was answering ai_failed on the workspace AI account,
 * a card that cannot work. Its worker, route and tests stay; take it out of this
 * set to bring the card back once the AI account answers.
 */
export const CONTENT_TOOLS_HIDDEN: ReadonlySet<string> = new Set(["repurpose_post"]);

export type CatalogDeps = {
  db?: Client;
  now?: Date;
  readAccount?: (tenantId: string) => Promise<WorkspaceAiAccount | null>;
};

export type CatalogOptions = {
  /**
   * "client" (default): every tool EXCEPT an operatorOnly one - what the
   * Content Tools page shows a workspace founder. "operator": ONLY the
   * operatorOnly tools - what Admin > Agent training shows a platform
   * operator. The audience decides which cards exist; it enforces nothing by
   * itself (lib/tools/session-handlers.ts refuses the run and jobs routes for
   * an operatorOnly tool to anyone who is not a platform operator, whichever
   * audience asked for the catalog).
   */
  audience?: "client" | "operator";
};

export async function getToolCatalog(
  viewer: { tenantId: string },
  deps: CatalogDeps = {},
  opts: CatalogOptions = {},
): Promise<ToolCatalog> {
  if (!deps.db && !tursoConfigured()) return { installed: false };
  const db = deps.db ?? getTursoClient();
  const now = deps.now ?? new Date();
  if (!(await toolTablesInstalled(db))) return { installed: false };

  const audience = opts.audience ?? "client";
  const registry = TOOL_REGISTRY.filter((t) =>
    audience === "operator" ? t.operatorOnly === true : !t.operatorOnly && !CONTENT_TOOLS_HIDDEN.has(t.key),
  );
  const needsAccount = registry.some((t) => t.needsAiAccount);
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
  for (const t of registry) {
    const base = { key: t.key, title: t.title, description: t.description, runLabel: t.runLabel, runsOn: t.runsOn, fields: t.fields };
    if (t.runsOn === "runner") {
      const runner = runners.find((r) => r.tools.includes(t.key));
      // Offline: the card stays, says so, and keeps its past runs (CatalogToolState),
      // but only in a workspace a runner can serve at all. The one producer serves
      // OASIS's own workspaces (runner-handlers PRODUCER_TENANTS); a client workspace
      // would be told about a computer that will never run its jobs, so it gets no card.
      if (!runner) {
        if (OASIS_INTERNAL_TENANT_IDS.has(viewer.tenantId)) tools.push({ ...base, state: "runner_offline" });
        continue;
      }
      // The time itself, not minutes: the grid counts the minutes on the
      // viewer's clock and keeps counting while the page stays open.
      tools.push({ ...base, state: "ready", runner: { label: runner.label, lastSeenAt: runner.lastSeenAt } });
      continue;
    }
    tools.push({ ...base, state: t.needsAiAccount ? aiState : "ready" });
  }
  return { installed: true, tools };
}
