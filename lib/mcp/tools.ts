/**
 * lib/mcp/tools.ts - the OASIS MCP server's tools: the department desk's own
 * toolset (lib/os/desk/*), seen through MCP. Nothing here decides what a person
 * may read or propose; the desk does, and this file only carries it across:
 *
 *   - tools/list is exactly deskToolset().palette for the bearer's department
 *     and profile ("read" = plan mode = no propose_*; "propose" adds them for a
 *     member who may act);
 *   - tools/call goes through the SAME execute, so the palette is enforced at
 *     dispatch, a tenant id the model writes is stripped, and a proposal needs
 *     canAct. A proposal makes an approvals card; nothing is sent;
 *   - every result is scrubbed as a department turn scrubs it
 *     (redactAll + the workspace vault, lib/os/desk/turn.ts) and text that came
 *     from outside the workspace (lead history, tickets, calendar invites, names)
 *     is fenced with wrapUntrusted;
 *   - a failure is a tool result with isError and plain words, never a stack
 *     trace, a key or a table name.
 *
 * The workspace's own credentials never leave the Worker: the CLI holds a
 * 60-minute bearer (./bearer.ts) and nothing else.
 */

import "server-only";
import { departmentGate } from "@/components/os/department/gate";
import { resolveOsViewerFor, type OsViewer } from "@/components/os/department/viewer";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import { deskToolset } from "@/lib/os/desk/tools";
import { DESK_TOOLS, type DeskToolName } from "@/lib/os/desk/catalog";
import { redactAll, redactTenantVaultSecrets, type VaultSecret } from "@/lib/secret-redaction";
import { fetchTenantVaultSecretsForRedaction } from "@/lib/chat-persistence";
import { wrapUntrusted } from "@/lib/llm-input-boundary";
import type { McpProfile, McpTokenClaims } from "./bearer";

/** The member and department a verified bearer stands for, re-checked this call. */
export type McpSession = {
  viewer: OsViewer;
  dept: OsDepartment;
  prof: McpProfile;
};

export type McpSessionRefusal = { ok: false; code: "seat_gone" | "department_closed" | "unavailable"; message: string };

/**
 * Fresh seat check, EVERY call: the member must still hold a seat in the
 * bearer's workspace, and the department's page must still open for them (the
 * rail's own gate, so a downgraded role loses the department at once).
 */
export async function resolveMcpSession(
  claims: McpTokenClaims,
  deps: { resolveViewer?: typeof resolveOsViewerFor } = {},
): Promise<({ ok: true } & McpSession) | McpSessionRefusal> {
  const viewer = await (deps.resolveViewer ?? resolveOsViewerFor)(claims.tid, claims.uid);
  if (!viewer.ok) {
    return viewer.reason === "degraded"
      ? { ok: false, code: "unavailable", message: "The workspace could not be read right now. Try again in a moment." }
      : { ok: false, code: "seat_gone", message: "This session no longer has access to the workspace." };
  }
  const dept = OS_DEPARTMENTS.find((d) => d.key === claims.dept);
  if (!dept || departmentGate(dept.slug, viewer.navInput) === null) {
    return { ok: false, code: "department_closed", message: "This department is not open to you." };
  }
  return { ok: true, viewer, dept, prof: claims.prof };
}

function toolsetFor(s: McpSession) {
  return deskToolset({
    viewer: s.viewer,
    dept: s.dept,
    // The approval card's requester. No colon: it is joined into a key with ":".
    agentSlug: `mcp-${s.dept.slug}`,
    planMode: s.prof === "read",
  });
}

export type McpToolDescriptor = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
};

/** tools/list: exactly this department's palette for this profile. */
export function listMcpTools(s: McpSession): McpToolDescriptor[] {
  return toolsetFor(s).palette.map((t) => {
    const read = t.kind === "read";
    return {
      name: t.name,
      title: t.label,
      description: t.description,
      inputSchema: t.input_schema,
      annotations: {
        title: t.label,
        readOnlyHint: read,
        // A proposal adds an approval card and changes or deletes nothing; it
        // sends nothing and reaches no outside system until a person approves.
        destructiveHint: false,
        idempotentHint: read,
        openWorldHint: false,
      },
    };
  });
}

export type McpToolResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };

/** Results whose text comes from outside the workspace (a lead's mail, a client's ticket, an invite). */
const OUTSIDE_TEXT: ReadonlySet<string> = new Set<DeskToolName>([
  "lead_timeline",
  "leads_search",
  "pipeline_summary",
  "tickets_list",
  "projects_list",
  "calendar_upcoming",
  "approvals_list",
]);

const PLAIN: Record<string, string> = {
  tool_not_in_this_department: "That tool is not part of this department.",
  read_only_member_cannot_propose: "Your role in this workspace can read but cannot propose actions.",
  no_access_to_leads: "You do not have access to leads in this workspace.",
  no_access_to_tickets: "You do not have access to tickets in this workspace.",
  no_access_to_projects: "You do not have access to projects in this workspace.",
  lead_not_found: "No lead with that id was found in this workspace.",
  only_your_own_department: "Only Chief of Staff can read another department.",
  department_not_open_to_you: "That department is not open to you.",
  routines_not_available_to_you: "Routines are available to owners and admins only.",
  company_money_not_available_to_you: "Company money is not available to you.",
  could_not_be_read: "That could not be read right now. Try again in a moment.",
  proposer_may_not_act: "Your role in this workspace cannot propose actions.",
};

function plainError(raw: string): string {
  let code = "";
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    code = typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    code = "";
  }
  const head = code.split(":")[0].trim();
  if (PLAIN[head]) return PLAIN[head];
  if (/^[a-z0-9_]{1,60}$/.test(head)) return `That could not be done: ${head.replace(/_/g, " ")}.`;
  return "That could not be done.";
}

const fail = (text: string): McpToolResult => ({ content: [{ type: "text", text }], isError: true });

/** tools/call. Never throws: any failure is an isError result in plain words. */
export async function callMcpTool(
  s: McpSession,
  name: string,
  args: unknown,
  deps: { loadVault?: (tenantId: string) => Promise<VaultSecret[]> } = {},
): Promise<McpToolResult> {
  const tenantId = s.viewer.surface.tenantId;
  let vault: VaultSecret[];
  try {
    // COMPLETE or nothing, as a department turn reads it: no result goes out
    // scrubbed of only some of the workspace's secrets.
    vault = await (deps.loadVault ?? ((id: string) => fetchTenantVaultSecretsForRedaction(id, { requireComplete: true })))(tenantId);
  } catch (err) {
    console.error("[mcp.tools.vault]", { tenantId, department: s.dept.key, error: err instanceof Error ? err.message : String(err) });
    return fail("The workspace could not be checked for secrets, so nothing was returned. Try again in a moment.");
  }
  const scrub = (text: string) => redactTenantVaultSecrets(redactAll(text), vault);

  let result: Awaited<ReturnType<ReturnType<typeof toolsetFor>["execute"]>>;
  try {
    const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    result = await toolsetFor(s).execute(name, input);
  } catch (err) {
    console.error("[mcp.tools.call]", { tool: name, department: s.dept.key, tenantId, error: err instanceof Error ? err.message : String(err) });
    return fail("That could not be done right now. Try again in a moment.");
  }

  if (result.is_error) return fail(scrub(plainError(result.content)));

  const body = scrub(result.content);
  const known = Object.prototype.hasOwnProperty.call(DESK_TOOLS, name);
  const text = known && OUTSIDE_TEXT.has(name) ? wrapUntrusted(body, { label: `oasis:${name}` }) : body;
  return { content: [{ type: "text", text }], isError: false };
}
