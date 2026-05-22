/**
 * Cloud tools layer — the Path B unlock for client onboarding.
 *
 * The local-bridge path (Path A) gives the agent the full Claude Code
 * tool surface (Read/Edit/Write/Bash/Glob/Grep + every MCP). The cloud
 * path (Path B) doesn't have file access, so we expose a curated set of
 * tenant-scoped tools the cloud agent can call instead.
 *
 * Pattern (matches the existing <dashboard-action> protocol so agents
 * learn one syntax for both):
 *
 *   <cloud-tool name="lookup_lead_by_name">
 *     {"name": "Jonathan"}
 *   </cloud-tool>
 *
 * The /api/chat route extracts these markers AFTER the model finishes
 * streaming, executes each via the registry below, and emits a
 * `cloud_tool_result` SSE event per call. The ChatWidget renders results
 * inline so the operator sees what the agent looked up.
 *
 * Today's tools are read-only and cover the highest-leverage queries
 * (lead lookup, pipeline overview, integration status). Future tools
 * will be added here — when a tool requires OAuth (Gmail send, Stripe
 * charge), declare requiresOAuth so the persona prompt knows to skip
 * it for tenants that haven't connected the integration yet.
 */

import { getServiceSupabase } from "./supabase-server";
import { downloadChatAttachmentText } from "./chat-attachments";
import { parseLeadImportCsv } from "./leads-import-parser";
import { importLeadsForTenant } from "./leads-import-service";
import { readBrainDoc, searchMemory } from "./cloud-knowledge-tools";

export type CloudToolContext = {
  tenantId: string;
  userId: string;
};

export type CloudToolResult =
  | { ok: true; name: string; data: unknown; summary: string }
  | { ok: false; name: string; error: string };

type CloudTool = {
  name: string;
  description: string;
  /** OAuth scopes required. Empty for read-only tools that hit Supabase directly. */
  requiresOAuth?: string[];
  /** JSON schema-ish — string description per arg so the persona prompt can teach the syntax. */
  args: Record<string, string>;
  execute: (
    input: Record<string, unknown>,
    ctx: CloudToolContext
  ) => Promise<CloudToolResult>;
};

// ============================================================================
// Tool implementations
// ============================================================================

const readBrainDocCloud: CloudTool = {
  name: "read_brain_doc",
  description:
    "Read an allowed knowledge file from the CEO-Agent repository, such as brain/STATE.md, CONTEXT.md, memory/*.md, docs/adr/*.md, or skills/*/SKILL.md.",
  args: {
    path: "Repo-relative path, e.g. 'brain/STATE.md' or 'CONTEXT.md'.",
    max_chars: "Optional max characters to return (default 12000, max 40000).",
  },
  async execute(input) {
    const data = await readBrainDoc(input);
    return {
      ok: true,
      name: "read_brain_doc",
      data,
      summary: `Read ${data.path}${data.truncated ? " (truncated)" : ""}.`,
    };
  },
};

const searchMemoryCloud: CloudTool = {
  name: "search_memory",
  description:
    "Search CEO-Agent brain and memory docs for a phrase and return ranked line-referenced snippets.",
  args: {
    query: "Search phrase, e.g. 'quiet day cron' or 'V6 architecture'.",
    limit: "Optional max snippets to return (default 8, max 20).",
  },
  async execute(input) {
    const data = await searchMemory(input);
    return {
      ok: true,
      name: "search_memory",
      data,
      summary: `Found ${data.count} memory match${data.count === 1 ? "" : "es"} for "${data.query}".`,
    };
  },
};

const lookupLeadByName: CloudTool = {
  name: "lookup_lead_by_name",
  description:
    "Find a specific lead by partial name match (case-insensitive). Returns up to 5 matches with status, score, and last contact date.",
  args: {
    name: "Partial name to search (e.g. 'Jonathan' or 'Hutton')",
  },
  async execute(input, ctx) {
    const name = String(input.name || "").trim();
    if (!name || name.length < 2) {
      return { ok: false, name: "lookup_lead_by_name", error: "name_too_short" };
    }
    const db = getServiceSupabase();
    const { data } = await db
      .from("leads")
      .select("id, name, email, status, score, source, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .ilike("name", `%${name}%`)
      .order("score", { ascending: false })
      .limit(5);
    const rows = (data || []) as Array<{
      id: string;
      name: string;
      email: string | null;
      status: string;
      score: number;
      source: string | null;
      updated_at: string;
    }>;
    if (rows.length === 0) {
      return {
        ok: true,
        name: "lookup_lead_by_name",
        data: { matches: [] },
        summary: `No leads matched "${name}".`,
      };
    }
    const summary = rows
      .map((r) => `${r.name} (${r.status}, score ${r.score})`)
      .join(", ");
    return {
      ok: true,
      name: "lookup_lead_by_name",
      data: { matches: rows },
      summary: `Found ${rows.length}: ${summary}`,
    };
  },
};

const listOpenLeads: CloudTool = {
  name: "list_open_leads",
  description:
    "List the top N open leads (status not in 'won', 'lost', 'archived'), highest-scoring first. Use this when the operator asks about pipeline or who to call next.",
  args: {
    limit: "Optional max number of leads to return (default 10, max 25)",
  },
  async execute(input, ctx) {
    const requested = Number(input.limit) || 10;
    const limit = Math.max(1, Math.min(25, requested));
    const db = getServiceSupabase();
    const { data } = await db
      .from("leads")
      .select("id, name, email, status, score, source, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .not("status", "in", "(won,lost,archived)")
      .order("score", { ascending: false })
      .limit(limit);
    const rows = (data || []) as Array<{
      id: string;
      name: string;
      status: string;
      score: number;
    }>;
    const summary =
      rows.length === 0
        ? "Pipeline empty."
        : `Top ${rows.length} open: ${rows
            .slice(0, 5)
            .map((r) => `${r.name} (${r.status}/${r.score})`)
            .join(", ")}${rows.length > 5 ? "…" : ""}`;
    return {
      ok: true,
      name: "list_open_leads",
      data: { leads: rows },
      summary,
    };
  },
};

const integrationStatus: CloudTool = {
  name: "integration_status",
  description:
    "Report which integrations the operator has connected (Stripe, Gmail, Late, etc.) and their current health. Use this when the operator asks 'what's connected' or before recommending a tool that requires an integration.",
  args: {},
  async execute(_input, ctx) {
    const db = getServiceSupabase();
    const { data } = await db
      .from("integrations_health")
      .select("service, status, last_ping_at")
      .eq("tenant_id", ctx.tenantId);
    const rows = (data || []) as Array<{
      service: string;
      status: string;
      last_ping_at: string | null;
    }>;
    const healthy = rows.filter((r) => r.status === "healthy").length;
    const summary =
      rows.length === 0
        ? "No integrations configured yet."
        : `${healthy} healthy / ${rows.length} configured.`;
    return {
      ok: true,
      name: "integration_status",
      data: { integrations: rows },
      summary,
    };
  },
};

const importLeadsFromAttachment: CloudTool = {
  name: "import_leads_from_attachment",
  description:
    "Parse a CSV uploaded through chat and import recognized SunBiz leads into the CRM with dedupe. Use only when the operator explicitly asks to import/sync/update leads from an attached CSV; use dry_run=true when they only ask you to inspect it.",
  args: {
    attachment_id: "UUID shown in the ATTACHED FILES block.",
    dry_run: "Optional boolean. true parses and previews without inserting.",
  },
  async execute(input, ctx) {
    const attachmentId = String(input.attachment_id || "").trim();
    if (!attachmentId) return { ok: false, name: "import_leads_from_attachment", error: "attachment_id_required" };
    const dryRun = input.dry_run === true;
    const { row, text } = await downloadChatAttachmentText({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      attachmentId,
    });
    const parsed = parseLeadImportCsv(text);
    const recognizedColumns = parsed.colMap.filter(Boolean).length;
    if (recognizedColumns === 0 || parsed.mapped.length === 0) {
      return { ok: false, name: "import_leads_from_attachment", error: "no_recognized_leads_in_attachment" };
    }
    if (dryRun) {
      return {
        ok: true,
        name: "import_leads_from_attachment",
        data: {
          dry_run: true,
          filename: row.filename,
          recognized_columns: recognizedColumns,
          parsed_rows: parsed.mapped.length,
          section_labels: parsed.sectionLabels,
          sample: parsed.mapped.slice(0, 5),
        },
        summary: `Parsed ${parsed.mapped.length} lead rows from ${row.filename}.`,
      };
    }
    const result = await importLeadsForTenant({
      tenantId: ctx.tenantId,
      rows: parsed.mapped,
      defaultSource: `chat_attachment:${row.filename}`,
    });
    if (!result.ok) {
      return {
        ok: false,
        name: "import_leads_from_attachment",
        error: `${result.error}${result.detail ? `: ${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      name: "import_leads_from_attachment",
      data: {
        filename: row.filename,
        recognized_columns: recognizedColumns,
        parsed_rows: parsed.mapped.length,
        inserted: result.inserted,
        skipped_duplicate: result.skipped_duplicate,
        skipped_malformed: result.skipped_malformed,
        duplicate_keys: result.duplicate_keys.slice(0, 10),
        errors: result.errors.slice(0, 10),
      },
      summary: `Imported ${result.inserted} leads from ${row.filename}; skipped ${result.skipped_duplicate} duplicates.`,
    };
  },
};

// ============================================================================
// Registry
// ============================================================================

export const CLOUD_TOOLS: Record<string, CloudTool> = {
  [readBrainDocCloud.name]: readBrainDocCloud,
  [searchMemoryCloud.name]: searchMemoryCloud,
  [lookupLeadByName.name]: lookupLeadByName,
  [listOpenLeads.name]: listOpenLeads,
  [integrationStatus.name]: integrationStatus,
  [importLeadsFromAttachment.name]: importLeadsFromAttachment,
};

// ============================================================================
// Marker parsing — matches the <cloud-tool name="..."> JSON </cloud-tool> shape
// ============================================================================

export type CloudToolSpec = {
  name: string;
  input: Record<string, unknown>;
};

export function extractCloudToolMarkers(text: string): CloudToolSpec[] {
  const out: CloudToolSpec[] = [];
  const re = /<cloud-tool\s+name="([a-z0-9_]+)"\s*>([\s\S]*?)<\/cloud-tool>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    const body = m[2].trim();
    let input: Record<string, unknown> = {};
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // tolerate empty / malformed bodies — execute will reject if args are required
      }
    }
    out.push({ name, input });
  }
  return out;
}

export async function runCloudTool(
  spec: CloudToolSpec,
  ctx: CloudToolContext
): Promise<CloudToolResult> {
  const tool = CLOUD_TOOLS[spec.name];
  if (!tool) {
    return { ok: false, name: spec.name, error: `unknown_cloud_tool:${spec.name}` };
  }
  try {
    return await tool.execute(spec.input, ctx);
  } catch (err) {
    return {
      ok: false,
      name: spec.name,
      error: err instanceof Error ? err.message : "tool_threw",
    };
  }
}

/**
 * Strip cloud-tool markers from chat text before persisting / displaying so
 * the operator doesn't see the raw XML. Mirrors stripActionMarkers in
 * lib/agent-actions.
 */
export function stripCloudToolMarkers(text: string): string {
  return text.replace(/<cloud-tool\s+name="[a-z0-9_]+"\s*>[\s\S]*?<\/cloud-tool>/gi, "");
}

/**
 * Generate the persona-prompt block that teaches every agent the cloud-tool
 * syntax + the current registry. Append to system prompts in the cloud
 * /api/chat path so agents know what they can call.
 */
export function cloudToolsPromptBlock(): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("CLOUD TOOLS");
  lines.push("");
  lines.push(
    "When you need data the operator hasn't given you in the DASHBOARD STATE block, you can call a cloud tool. Emit a marker like this (one per call; multiple OK):"
  );
  lines.push("");
  lines.push('  <cloud-tool name="TOOL_NAME">');
  lines.push('    {"arg": "value"}');
  lines.push("  </cloud-tool>");
  lines.push("");
  lines.push("The /api/chat route runs the tool AFTER your message finishes and surfaces the result to the operator inline. Tools available:");
  lines.push("");
  for (const t of Object.values(CLOUD_TOOLS)) {
    const argList = Object.entries(t.args)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    lines.push(`- ${t.name} — ${t.description}${argList ? ` Args: ${argList}` : ""}`);
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("- Only call a tool when the answer requires fresh data not already in DASHBOARD STATE.");
  lines.push("- Confirm the result in your reply text after the marker (\"Found 3 matches: …\").");
  lines.push("- Don't speculate about tool output — wait for the operator to see it before drawing conclusions.");
  return lines.join("\n");
}
