/**
 * lib/playbook-access.ts — who may read /playbook (F0 containment, 2026-09-29).
 *
 * /playbook renders OASIS's own operating material: the SOP markdown in
 * content/playbooks (including runbooks that name the private harness repo),
 * the operator prompt library and the client-deploy runbook. lib/os/nav.ts
 * shows the Playbook row to OASIS workspaces only (`oasisOnly`), but hiding a
 * nav row enforces nothing: until this guard every /playbook URL rendered for
 * any signed-in member of any workspace who typed it.
 *
 * The rule is the nav's (isOasisSurfaceTenant on the viewer's workspace slug)
 * AND the tenant-id rule the client tool sandbox uses (isOasisInternalTenant).
 * A slug is display text a workspace can claim; the id is a primary key, so a
 * workspace that claimed an OASIS slug still gets the 404. Every persona inside
 * OASIS may read it: each narrowed persona's nav allowlist includes /playbook
 * (lib/role-surfaces.ts), and the rep call guide lives under it.
 *
 * Every page under app/playbook calls requirePlaybookReader() as its first
 * statement (the founders' pages call requirePlaybookFounder(), which is
 * narrower). A layout would not do: Next skips a shared layout when a client
 * navigates between its child pages, so only the page itself runs on every
 * request. tests/f0-containment.test.ts renders every page file under
 * app/playbook as a client of another workspace and expects the 404, so a new
 * page without the guard fails the suite.
 */
import { notFound } from "next/navigation";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { viewerReadsInternalAgentNames } from "@/lib/os/agent-names-session";

/** Pure rule: an OASIS workspace by both its slug (the nav's test) and its id. */
export function isOasisPlaybookWorkspace(workspace: { tenantId: string | null | undefined; tenantSlug: string | null | undefined }): boolean {
  return isOasisInternalTenant(workspace.tenantId) && isOasisSurfaceTenant(workspace.tenantSlug);
}

/**
 * True only for a signed-in member of an OASIS workspace. No session, no
 * profile, an unresolved slug and a lookup error are all false (fail closed,
 * and the error is logged).
 */
export async function mayReadPlaybook(): Promise<boolean> {
  try {
    const surface = await resolveViewerSurface();
    return surface.ok && isOasisPlaybookWorkspace(surface);
  } catch (err) {
    console.error("[playbook.access]", err);
    return false;
  }
}

/** First statement of every /playbook page: 404 for anyone who is not an OASIS member. */
export async function requirePlaybookReader(): Promise<void> {
  if (!(await mayReadPlaybook())) notFound();
}

/**
 * The Playbook pages written for OASIS's founders alone: the operator prompts
 * library and the client-deploy runbook. Their copy is OASIS's own agent
 * harness at work: the agents by name, and in the commands and paths they
 * carry ("agent_inbox.py --to bravo", ".bravo/profiles"), which no renaming can
 * make true for anyone else (lib/os/agent-names.ts). The index and the drills
 * link them for the founders only.
 */
export const FOUNDER_PLAYBOOK_PATHS: readonly string[] = ["/playbook/prompts", "/playbook/client-deploy"];

/** True for a link to one of FOUNDER_PLAYBOOK_PATHS (with or without a query, a fragment or a sub-path). */
export function isFounderPlaybookHref(href: string | null | undefined): boolean {
  const h = (href || "").trim().toLowerCase();
  return FOUNDER_PLAYBOOK_PATHS.some((p) => h === p || h.startsWith(`${p}?`) || h.startsWith(`${p}#`) || h.startsWith(`${p}/`));
}

/**
 * First statement of a page in FOUNDER_PLAYBOOK_PATHS, in place of
 * requirePlaybookReader: 404 for anyone who does not read OASIS's internal
 * agent names (an OASIS founder; lib/os/agent-names-session.ts
 * readsInternalAgentNames), the same answer as a page that does not exist.
 */
export async function requirePlaybookFounder(): Promise<void> {
  if (!(await viewerReadsInternalAgentNames())) notFound();
}
