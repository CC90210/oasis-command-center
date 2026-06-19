/**
 * Cloud tool-runner — native Anthropic tool_use loop for the API-key chat path.
 *
 * Why this exists: the older lib/cloud-tools.ts is a TEXT-MARKER protocol —
 * the model emits `<cloud-tool name="...">{...}</cloud-tool>`, the stream
 * completes, then we parse + execute and surface results. That works but
 * has three real problems:
 *
 *   1. The model has to "remember" the syntax via a long persona block.
 *   2. Tools can't influence the model's subsequent reasoning — results
 *      arrive AFTER the message is done.
 *   3. We can't chain tools (read → decide → write) because there's only
 *      one round of execution.
 *
 * The native Anthropic tool_use protocol (https://docs.anthropic.com/en/docs/
 * agents-and-tools/tool-use/overview) solves all three. The model emits
 * tool_use blocks mid-stream, we execute, we send tool_result back, and
 * the loop continues until stop_reason !== "tool_use".
 *
 * This file owns:
 *   - TOOL_DEFINITIONS: the JSONSchema-shaped tool specs we send to Anthropic
 *   - executeTool(): server-side dispatcher; calls into agent-actions /
 *     cloud-tools / new HTTP helpers
 *   - streamAnthropicWithTools(): the orchestrator — opens an /v1/messages
 *     stream, accumulates tool_use blocks, executes them, re-opens the
 *     stream with tool_results appended, repeats. Yields {type:"delta"} for
 *     text and {type:"tool_use"} / {type:"tool_result"} so the API route
 *     can surface tool activity to the operator in real time.
 *
 * Safety: only tenant-scoped + URL-safelisted operations. No shell exec, no
 * file-system access. Power comes from data breadth (records, http, memory),
 * not from arbitrary code execution. Phase v2 will add a sandboxed shell
 * via E2B or Vercel Sandbox.
 */

import { fetchWithRetry } from "./retry";
import { getServiceSupabase } from "./supabase-server";
import { getManifest } from "./manifest/loader";
import { resolveClientProfileSlug } from "./client-profiles";
import {
  getRecord as dataGet,
  listRecords as dataList,
} from "./manifest/data";
import { runAction } from "./agent-actions";
import { CLOUD_TOOLS } from "./cloud-tools";
import { dispatchOasisOnlyEvent } from "./lead-stage-dispatcher";
import type { OasisLeadStageEvent } from "./oasis-lead-stage-engine";
import { asSSEArray, asSSERecord, parseSSE, safeText } from "./sse-parser";
import { downloadChatAttachmentText } from "./chat-attachments";
import { parseLeadImportCsv } from "./leads-import-parser";
import { importLeadsForTenant } from "./leads-import-service";
import {
  type ChatPlanMode,
  composeSystemPrompt as composePlanSystemPrompt,
  filterToolsForMode,
  normalizeMode,
} from "./chat-modes/plan-mode";
import { readBrainDoc, searchMemory } from "./cloud-knowledge-tools";
import { PROFILE_CUSTOM_FIELD_KEYS } from "./profile-custom-fields";
import {
  getTenantIntegrationValue,
  setTenantIntegrationValue,
  VAULT_CUSTOM_SERVICE,
} from "./tenant-integration-store";
import { isDryRun } from "./integrations/send-mode";
import { normalizePhoneE164, isPhoneOptedOut } from "./lead-interactions-queries";
import { getUserIntegrationValue } from "./user-integration-store";
import {
  getKixieCredentials,
  makeCall as kixieMakeCall,
  sendSms as kixieSendSms,
} from "./integrations/kixie";
import {
  getTextTorrentCredentials,
  sendSms as ttSendSms,
  replyToThread as ttReplyToThread,
  createCampaign as ttCreateCampaign,
  createList as ttCreateList,
  addContact as ttAddContact,
  blockContact as ttBlockContact,
  unblockContact as ttUnblockContact,
} from "./integrations/texttorrent";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOOL_ITERATIONS = 8; // safety cap — prevents runaway tool loops
const HTTP_BODY_CAP_BYTES = 5 * 1024 * 1024; // 5 MB max external response
const HTTP_TIMEOUT_MS = 15_000;

// ============================================================================
// Tool context — server-only state needed to execute tools on behalf of a user
// ============================================================================

export type ToolContext = {
  tenantId: string;
  userId: string;
  agentKey: string;
  /** Required to call runAction (it uses auth_user_id for profile-bound writes). */
  authUserId: string;
  /**
   * True if the caller is owner/admin of the tenant (canManageTenant).
   * Gates admin-only tools like get_credential — non-admin members
   * cannot pull decrypted vault secrets via chat even though they have
   * chat access. Resolved server-side in app/api/chat/route.ts before
   * the tool loop starts.
   */
  isAdmin: boolean;
};

export type ToolUseBlock = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  /** Anthropic tool_result.content — JSON-stringified data the model reads. */
  content: string;
  is_error: boolean;
  /** Human-summary shown to the operator in the chat UI alongside the chip. */
  summary: string;
};

// ============================================================================
// Tool definitions — Anthropic JSONSchema format
// ============================================================================

type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * When true, the streaming loop does NOT execute this tool server-side.
   * Instead it yields { type: "tool_use_pending", resume_state } and exits
   * — the caller (the /api/chat route) emits a tool_use_pending SSE event,
   * the browser POSTs the call to its local bridge (Phase 2 of giggly-reef),
   * and the dashboard hits /api/chat/resume with the bridge-produced
   * tool_result to continue the Anthropic iteration.
   *
   * Mark this on tools that need the operator's local machine (file I/O,
   * shell, emails sent from their .env.agents credentials). Leave it off
   * for tools that the cloud runner can execute itself (records, http).
   */
  defer?: boolean;
};

/**
 * The full tool palette the cloud agent gets when running on the API-key path.
 * Mirrors Claude Code's "Read / Write / Edit / Bash / Glob / Grep" tools, but
 * the scope is the tenant's dashboard data + the open web, not the operator's
 * local filesystem.
 *
 * Ordering matters for the model's attention budget — put the most-likely
 * useful tools first.
 */
export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "read_brain_doc",
    description:
      "Read an allowed knowledge file from the CEO-Agent repository (brain/*.md, memory/*.md, CONTEXT.md, AGENTS.md, docs/adr/*.md, or a skill's SKILL.md). Use this in cloud mode when the operator asks about repo brain/state/docs and the local bridge is not required.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repo-relative path, for example 'brain/STATE.md', 'CONTEXT.md', or 'skills/outreach-send/SKILL.md'.",
        },
        max_chars: {
          type: "number",
          description: "Optional max characters to return. Default 12000, max 40000.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_memory",
    description:
      "Search the CEO-Agent brain and memory docs for a phrase and return ranked line-referenced snippets. Use before reading whole files when the operator asks whether the system has seen a topic, mistake, SOP, or prior decision before.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search phrase, for example 'quiet day cron' or 'V6 architecture'." },
        limit: { type: "number", description: "Optional max snippets to return. Default 8, max 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "add_credential",
    description:
      "Save a new credential to the vault (admin only — same gate as Settings → Custom credentials). Use this when the operator gives you a secret in chat that future chats will need (an API key they just generated, a webhook URL for a new integration, etc.). After saving, tell the operator what KEY name you saved it as so they can find it under Settings if they need to edit or delete. NEVER call this for the operator's PERSONAL transient secrets (one-time tokens, OTP codes, passwords); only evergreen workflow credentials.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Credential KEY in UPPER_SNAKE_CASE (e.g., 'STRIPE_WEBHOOK_SECRET'). Pick a name that future-you would guess on the first try.",
        },
        value: {
          type: "string",
          description: "The secret value the operator gave you. Stored encrypted at rest.",
        },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "get_credential",
    description:
      "Retrieve a secret credential (API key, webhook URL, access token) the operator saved in Settings → Custom credentials. Use this BEFORE asking the operator for a credential they may have already stored. The value is returned but you should NEVER echo it back to the operator in chat — pass it directly to the action that needs it (e.g., http_post Authorization header) and tell the operator what you did, not what the value was. If the credential doesn't exist, you'll get {found:false} — at that point, tell the operator the credential is missing and which exact KEY name to add under Settings → Custom credentials.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The credential key, UPPER_SNAKE_CASE (e.g., 'STRIPE_WEBHOOK_SECRET', 'CALENDLY_API_KEY'). Matches the key the operator typed in Settings.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "save_known_fact",
    description:
      "Append an evergreen fact about the operator to their KNOWN FACTS (user_profiles.custom_fields.quick_facts). Call this WHEN the operator tells you something you'll likely need in future chats — calendar booking link, email signature, business name, preferred tone, common phrasings, brand assets. Each call adds ONE bullet. After saving, briefly confirm what you saved so the operator can edit it in Settings if needed. Do NOT save secrets, passwords, or one-time tokens; do NOT save transient task details (those belong in the conversation, not in evergreen facts). Per-user — each user only writes their own profile.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description:
            "One single fact, written as a self-contained bullet (e.g., 'Calendar booking link: https://cal.com/cc' or 'Email signature: Best, CC — OASIS AI · oasisai.work'). Keep under 500 chars.",
        },
      },
      required: ["fact"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a public URL with the same SSRF protections as http_get. Use when the operator asks to read a page, inspect public docs, or summarize a pasted URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute public URL." },
        headers: { type: "object", description: "Optional non-auth request headers as a string-to-string map." },
      },
      required: ["url"],
    },
  },
  {
    name: "list_records",
    description:
      "List rows from one of the tenant's manifest-defined entities (e.g., 'lead', 'application', 'funded_deal', 'renewal'). Use this when the operator asks 'what leads are in the pipeline?', 'show me recent applications', or 'what's expiring soon'. Returns up to 100 rows ordered by created_at desc unless you pass sort.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "The entity name as defined in the tenant's manifest (e.g. 'lead', 'application', 'funded_deal')." },
        filter: { type: "object", description: "Optional field→value equality filters. Example: {\"status\": \"qualified\"}." },
        sort: { type: "string", description: "Optional 'field' (asc) or '-field' (desc). Example: '-created_at'." },
        limit: { type: "number", description: "Max rows to return. Default 25, max 100." },
      },
      required: ["entity"],
    },
  },
  {
    name: "get_record",
    description:
      "Fetch a single record by ID. Use this when you have a record's ID from list_records and need its full data, or when the operator gives you a specific ID.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name (e.g. 'lead')." },
        id: { type: "string", description: "The record's UUID." },
      },
      required: ["entity", "id"],
    },
  },
  {
    name: "search_records",
    description:
      "Text-search across an entity's data fields. Use when the operator describes a record by name or a substring instead of giving an ID ('find the lead named Jonathan', 'which application mentions ABC Corp').",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name to search within." },
        query: { type: "string", description: "Substring to match (case-insensitive)." },
        limit: { type: "number", description: "Max rows to return. Default 10, max 25." },
      },
      required: ["entity", "query"],
    },
  },
  {
    name: "create_record",
    description:
      "Create a new row in one of the tenant's entities. Use when the operator says 'log a new funded deal', 'add this lead', 'note this renewal'. The 'data' object must include every field the entity marks as required.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name." },
        data: { type: "object", description: "Field→value map matching the entity's schema." },
      },
      required: ["entity", "data"],
    },
  },
  {
    name: "update_record",
    description:
      "Patch one or more fields on an existing record. Use for status changes, stage advances, edits.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name." },
        id: { type: "string", description: "Record UUID." },
        patch: { type: "object", description: "Field→newValue map. Only supplied fields are changed." },
      },
      required: ["entity", "id", "patch"],
    },
  },
  {
    name: "delete_record",
    description:
      "Hard-delete a record by ID. Confirm with the operator before calling — there is no undo.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name." },
        id: { type: "string", description: "Record UUID." },
      },
      required: ["entity", "id"],
    },
  },
  {
    name: "advance_lead_stage",
    description:
      "Move a lead through its lifecycle by firing a stage-engine event. " +
      "Use this (NOT update_record with a stage patch) when the operator " +
      "says things like 'mark Bennett as lost', 'Acme just churned', 'I " +
      "got off the phone with Windsor — they signed the contract', or 'move " +
      "this lead to archived'. The engine validates the transition, emits " +
      "the proper timeline event, and invalidates the dashboard cache so " +
      "the kanban + active-clients tab refresh immediately. " +
      "Event types (OASIS): manual_outreach_started (-> outreach), " +
      "discovery_call_scheduled (-> discovery), lead_qualified (-> " +
      "qualified), proposal_sent (-> proposal), proposal_viewed (-> " +
      "negotiation), contract_signed (-> onboarding), onboarding_complete " +
      "(-> active_client), lead_replied_negative (-> lost), contract_ended " +
      "(-> churned, only from active_client), manual_archive (-> archived). " +
      "Find the lead's UUID first via search_records or list_records.",
    input_schema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "Lead UUID." },
        event_type: {
          type: "string",
          description: "One of: manual_outreach_started, discovery_call_scheduled, lead_qualified, proposal_sent, proposal_viewed, contract_signed, onboarding_complete, lead_replied_negative, contract_ended, manual_archive.",
        },
      },
      required: ["lead_id", "event_type"],
    },
  },
  {
    name: "http_get",
    description:
      "Fetch a public URL via HTTP GET. Use for reading public web pages, public JSON APIs, or any URL the operator pastes. Returns the response body (truncated to 5MB) plus status code and content-type. Do NOT use for authenticated requests that require operator-scoped credentials — those need an integration connector instead.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL (https:// preferred)." },
        headers: { type: "object", description: "Optional request headers as a string→string map." },
      },
      required: ["url"],
    },
  },
  {
    name: "http_post",
    description:
      "POST a JSON body to a public URL. Use for calling public APIs that don't require operator credentials. Same response shape as http_get.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL." },
        body: { description: "JSON body (object or array) to send." },
        headers: { type: "object", description: "Optional request headers." },
      },
      required: ["url", "body"],
    },
  },
  {
    name: "lookup_lead_by_name",
    description:
      "Convenience shortcut over search_records for the 'lead' entity. Returns top 5 matches by score with status + last update.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Partial name to search (e.g. 'Jonathan')." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_open_leads",
    description:
      "Convenience shortcut: top N leads whose status is not won/lost/archived, highest score first.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 10, max 25." },
      },
    },
  },
  {
    name: "integration_status",
    description:
      "List the operator's connected integrations (Stripe, Gmail, Late, etc.) with health. Use before recommending an action that needs an integration.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_lead_documents",
    description:
      "List documents the prospect uploaded against a lead — bank statements, ID, proof of ownership, etc. Returns filename, doc_type (matches the SunBiz classifier enum: bank_statements_3mo / drivers_license / proof_of_ownership / void_cheque / business_license / tax_returns / other / unclassified), size, when they uploaded, and which form field they came from. Use this when the operator asks 'what docs do I have for this lead', 'are we missing anything for the application', or before recommending a lender shop-out. Returns metadata only — the operator views the file itself via the dashboard's Documents panel.",
    input_schema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "The lead's UUID." },
        doc_type: {
          type: "string",
          description:
            "Optional filter — only return documents whose doc_type matches this string (e.g. 'bank_statements_3mo').",
        },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "import_leads_from_attachment",
    description:
      "Parse a CSV file uploaded through the chat attachment button and import recognized SunBiz leads into tenant_records(entity_type='lead') with the same hardened parser, stage normalization, and dedupe rules as the Import page. Use only when the operator explicitly asks you to import/sync/update the CRM from an attached lead CSV. If they only ask you to inspect it, use dry_run=true.",
    input_schema: {
      type: "object",
      properties: {
        attachment_id: {
          type: "string",
          description: "UUID of the chat attachment. The prompt lists attachment_id for each uploaded file.",
        },
        dry_run: {
          type: "boolean",
          description: "When true, parse and summarize without inserting records. Default false when the operator explicitly asks to import.",
        },
      },
      required: ["attachment_id"],
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // SunBiz comms tools (Phase 3d, 2026-06-02) — Kixie click-to-call/SMS +
  // TextTorrent SMS / blasts / list management. defer:false — they run
  // server-side on Vercel via the typed clients (lib/integrations/*), same
  // as the drawer Call button. Every send respects the dashboard dry-run
  // gate (lib/integrations/send-mode.ts). Send-capable tools are in
  // READ_ONLY_DENIED_TOOLS and only reach Helios via HELIOS_TOOL_PALETTE.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "kixie_call",
    description:
      "Place a Kixie click-to-call (alley-oop: rings the acting employee's line first, then bridges to the prospect). Pass lead_id to dial the lead's stored phone, or target for an explicit E.164 number. Respects dry-run.",
    input_schema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "Lead UUID — the stored phone is dialed." },
        target: { type: "string", description: "Explicit phone (E.164, e.g. +14165551212). Used when no lead_id." },
        display_name: { type: "string", description: "Optional call-card label." },
      },
    },
  },
  {
    name: "kixie_send_sms",
    description:
      "Send an SMS via Kixie, attributed to the acting employee. Pass lead_id (uses the lead's phone) or target. Include opt-out language on first touch (Reply STOP to opt out) — TCPA. Respects dry-run.",
    input_schema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "Lead UUID — uses the lead's stored phone." },
        target: { type: "string", description: "Explicit recipient phone (E.164). Used when no lead_id." },
        message: { type: "string", description: "SMS body." },
      },
      required: ["message"],
    },
  },
  {
    name: "texttorrent_send",
    description:
      "Send a 1:1 SMS via TextTorrent to a phone number. Include opt-out language on first touch (TCPA). Respects dry-run.",
    input_schema: {
      type: "object",
      properties: {
        number: { type: "string", description: "Recipient phone (E.164)." },
        message: { type: "string", description: "SMS body." },
      },
      required: ["number", "message"],
    },
  },
  {
    name: "texttorrent_blast",
    description:
      "Create a TextTorrent bulk campaign to a contact list. High blast radius — confirm with the operator first. Include opt-out language. Respects dry-run.",
    input_schema: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "TextTorrent contact list ID (see texttorrent_create_list / the Campaigns page)." },
        message: { type: "string", description: "Campaign message body." },
        scheduled_time: { type: "string", description: "Optional ISO 8601 send time. Omit to send immediately." },
      },
      required: ["list_id", "message"],
    },
  },
  {
    name: "texttorrent_inbox_reply",
    description:
      "Reply to an existing TextTorrent 1:1 conversation by phone number (threads on TT's side). Respects dry-run.",
    input_schema: {
      type: "object",
      properties: {
        number: { type: "string", description: "The contact's phone (E.164)." },
        message: { type: "string", description: "Reply body." },
      },
      required: ["number", "message"],
    },
  },
  {
    name: "texttorrent_create_list",
    description:
      "Create a new TextTorrent contact list. Name max 15 chars (TT limit).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "List name (≤15 chars)." },
      },
      required: ["name"],
    },
  },
  {
    name: "texttorrent_add_contact",
    description:
      "Add a contact to a TextTorrent list. Use before a blast so the list is populated.",
    input_schema: {
      type: "object",
      properties: {
        first_name: { type: "string", description: "Contact first name." },
        number: { type: "string", description: "Contact phone (E.164)." },
        list_id: { type: "string", description: "Target TextTorrent list ID." },
        last_name: { type: "string", description: "Optional last name." },
        email: { type: "string", description: "Optional email." },
        company: { type: "string", description: "Optional company." },
      },
      required: ["first_name", "number", "list_id"],
    },
  },
  {
    name: "texttorrent_block",
    description:
      "Block a contact from TextTorrent sends (opt-out / do-not-contact). Pass contact_id or number.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "TextTorrent contact ID." },
        number: { type: "string", description: "Phone to block (E.164). Used when no contact_id." },
      },
    },
  },
  {
    name: "texttorrent_unblock",
    description:
      "Unblock previously-blocked TextTorrent contacts by their contact IDs.",
    input_schema: {
      type: "object",
      properties: {
        contact_ids: {
          type: "array",
          items: { type: "string" },
          description: "TextTorrent contact IDs to unblock.",
        },
      },
      required: ["contact_ids"],
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Bridge-proxied tools (defer: true) — these execute on the operator's
  // local machine via bravo_cli/bridge_tools.py. The runner pauses on
  // tool_use, the browser POSTs to localhost:9100/exec-tool, the result
  // gets POSTed back to /api/chat/resume. See bridge_tools.py for the
  // server-side implementations.
  //
  // If the bridge is offline when one of these fires, the browser-side
  // proxy returns is_error=true with "bridge_unreachable:..." in the
  // tool_result — the model sees the failure and can adapt (suggest the
  // operator start the bridge, or fall back to a cloud-only approach).
  // ──────────────────────────────────────────────────────────────────
  {
    name: "read_file",
    description:
      "Read a file from the operator's local machine. Relative paths resolve against the Bravo repo root; absolute paths work too. Returns up to 200KB of content; larger files get a head + truncation note. Use when the operator references a file, asks 'what's in X', or needs SKILL.md / brain/* context.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path OR path relative to the Bravo repo root." },
        max_bytes: { type: "number", description: "Optional cap on returned bytes (default 200000)." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file on the operator's local machine. Use sparingly — confirm with the operator before writing. Parent directories are auto-created.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Destination path (absolute or repo-relative)." },
        content: { type: "string", description: "Full file content to write." },
        create_dirs: { type: "boolean", description: "Create missing parent dirs (default true)." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command on the operator's local machine. 60-second timeout. Use for grep / find / git / npm / python invocations. Returns combined stdout+stderr with the exit code. For destructive commands (rm, drop, force-push), confirm with the operator first.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: { type: "string", description: "Optional working directory (default Bravo repo root)." },
        timeout_s: { type: "number", description: "Override default 60s timeout (max 300)." },
      },
      required: ["command"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email via the operator's Gmail account (uses scripts/google_tool.py with the operator's stored OAuth). Use when the operator says 'send an email to X' or 'reply to that lead'. Always include a professional subject and body. The 'from' field defaults to the operator's primary Gmail.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Email body (plain text or markdown — Gmail renders both)." },
        from: { type: "string", description: "Optional sender — defaults to operator's primary." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_sms",
    description:
      "Send an SMS via the operator's Twilio account. Honors the local opt-out list. Always include opt-out language ('Reply STOP to opt out') in the first touch — TCPA requires it. For cold outreach, confirm consent posture with the operator first.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient phone number (E.164 format preferred, e.g. +12025551234)." },
        body: { type: "string", description: "SMS body. Keep under 160 chars to avoid multi-part billing." },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "list_scripts",
    description:
      "List every Python script in the operator's scripts/ directory with a one-line synopsis. The catalog is ~50–150 entries depending on the tenant. Use this FIRST when you need to do something that isn't covered by the typed tools (read_file, write_file, bash, send_email, send_sms) — there's almost certainly a script already written for it. Scripts ending in '_tool.py' (e.g. stripe_tool.py, supabase_tool.py) are the documented CLI layer and support --json + --help. The 'filter' arg matches against script names (case-insensitive) — useful for narrowing down to 'stripe', 'send', 'snapshot', etc.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring filter on script names (case-insensitive)." },
      },
    },
  },
  {
    name: "run_script",
    description:
      "Run a Python script from the operator's scripts/ directory by name. Returns exit_code, stdout, stderr, and (if stdout parses as JSON) a 'parsed' field with the structured data. 90-second timeout (override up to 300 via timeout_s). Most documented tools support `--help` to discover args and `--json` for machine-readable output — pass those in args. Use list_scripts first to discover what's available. For commands outside scripts/, use the bash tool instead.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "Script filename, e.g. 'stripe_tool.py'. Resolved against scripts/ — no paths, no traversal. The .py suffix is optional.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Argv list passed to the script. Example for stripe_tool.py: ['list-customers', '--limit', '10', '--json'].",
        },
        timeout_s: {
          type: "number",
          description: "Override the default 90s timeout (max 300).",
        },
        parse_json: {
          type: "boolean",
          description: "Try to parse stdout as JSON into a 'parsed' field. Default true. Set false for scripts that emit prose.",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "list_skills",
    description:
      "List the operator's SKILL.md playbooks under skills/. Each entry has a name, description, and trigger phrases. Use this FIRST when the operator asks for something procedural (a briefing, a workflow, a recurring task) — there's almost certainly an existing playbook you should follow rather than improvising. The 'filter' arg matches case-insensitively across name, description, and trigger phrases.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional substring filter. Matches against skill name, description, and triggers (case-insensitive). Try keywords from the operator's request: 'briefing', 'closing', 'debug', 'outreach'.",
        },
      },
    },
  },
  {
    name: "load_skill",
    description:
      "Load the full SKILL.md body for a named skill. Use after list_skills points at the right one. The file contains the SOP — step-by-step instructions you should follow verbatim instead of guessing. Skills often reference Python scripts in scripts/ — chain into run_script after reading.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name as returned by list_skills (e.g. 'ceo-briefing', 'sales-closing'). Same as the directory name under skills/.",
        },
      },
      required: ["name"],
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Typed wrappers for the documented *_tool.py CLI layer — Phase C.
  // Each takes {action, args?} and shells out to the operator's local
  // scripts/<tool>.py with --json auto-appended. Same execution path
  // as run_script under the hood, just typed + advertised.
  // ──────────────────────────────────────────────────────────────────
  {
    name: "stripe",
    description:
      "Stripe SDK — universal payment access across all the operator's connected Stripe accounts. Actions: list-accounts, balance, customers, products, prices, invoices, subscriptions, charges, payment-links, create-payment-link, create-price, quick-link, create-customer, create-invoice, refund, events. Call action='--help' to see args for each. The wrapper auto-appends --json so you get structured output.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Subcommand name. Examples: 'customers', 'balance', 'create-payment-link', 'refund'. Pass '--help' to discover args for a specific action.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Argv for the action. Example: ['--limit', '10', '--account', 'oasis_ai'].",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "supabase",
    description:
      "Supabase — query the operator's database, list/get/insert/update/delete records, run raw SQL. Use this for ad-hoc data work that doesn't fit a manifest entity. The list_records / get_record / update_record cloud tools are usually a better choice for tenant_records data — supabase is for non-manifest tables (auth.users, integrations_health, etc.).",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Subcommand. Examples: 'query', 'list', 'get', 'insert', '--help'." },
        args: { type: "array", items: { type: "string" }, description: "Argv for the action." },
      },
      required: ["action"],
    },
  },
  {
    name: "n8n",
    description:
      "n8n workflow automation — list workflows, execute by name/ID, get execution status, manage webhooks. Use to kick off the operator's automated processes (lead enrichment, email sequences, etc.).",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Subcommand. Pass '--help' to discover." },
        args: { type: "array", items: { type: "string" }, description: "Argv for the action." },
      },
      required: ["action"],
    },
  },
  {
    name: "firecrawl",
    description:
      "Firecrawl — scrape a URL or crawl a site, return clean markdown. Use for competitor research, page content extraction, drafting from a real source. Falls back to http_get if Firecrawl credentials aren't configured.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Subcommand: 'scrape', 'crawl', 'map', '--help'." },
        args: { type: "array", items: { type: "string" }, description: "Argv for the action. Example for scrape: ['https://example.com', '--format', 'markdown']." },
      },
      required: ["action"],
    },
  },
  {
    name: "notebooklm",
    description:
      "NotebookLM — query the operator's curated knowledge base with citations. Use for grounded answers from their documented sources (vs. open-web speculation). Requires NotebookLM credentials in .env.agents; if missing, the action will return an is_error with the credential hint.",
    defer: true,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Subcommand: 'query', 'list-notebooks', '--help'." },
        args: { type: "array", items: { type: "string" }, description: "Argv for the action." },
      },
      required: ["action"],
    },
  },
];

// ============================================================================
// Server-side tool execution
// ============================================================================

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultBlock> {
  try {
    const data = await dispatch(name, input, ctx);
    return {
      content: JSON.stringify(data),
      is_error: false,
      summary: humanSummary(name, input, data),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tool_threw";
    return {
      content: JSON.stringify({ error: msg }),
      is_error: true,
      summary: `${name} failed: ${msg}`,
    };
  }
}

async function dispatch(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  switch (name) {
    case "read_brain_doc":
      // Default to the active agent's own repo; an explicit agent_slug in
      // input still wins (spread last) so an agent can cross-read if asked.
      return await readBrainDoc({ agent_slug: ctx.agentKey, ...input });
    case "search_memory":
      return await searchMemory({ agent_slug: ctx.agentKey, ...input });
    case "save_known_fact":
      return await toolSaveKnownFact(input, ctx);
    case "get_credential":
      return await toolGetCredential(input, ctx);
    case "add_credential":
      return await toolAddCredential(input, ctx);
    case "web_fetch":
      return await toolHttpGet(input);
    case "list_records":
      return await toolListRecords(input, ctx);
    case "get_record":
      return await toolGetRecord(input, ctx);
    case "search_records":
      return await toolSearchRecords(input, ctx);
    case "create_record":
    case "update_record":
    case "delete_record": {
      // Delegate to the canonical agent-actions handler so cloud-tool writes
      // share the same validation, manifest-scoping, and audit log as the
      // text-marker path. Returns a summary string, not the row; that's fine
      // — the model can call get_record afterward if it needs the data.
      const r = await runAction({ type: name, payload: input }, {
        tenantId: ctx.tenantId,
        authUserId: ctx.authUserId,
      });
      if (!r.ok) throw new Error(r.error);
      return { ok: true, summary: r.summary };
    }
    case "http_get":
      return await toolHttpGet(input);
    case "http_post":
      return await toolHttpPost(input);
    case "lookup_lead_by_name":
    case "list_open_leads":
    case "integration_status": {
      const legacy = CLOUD_TOOLS[name];
      if (!legacy) throw new Error(`unknown_tool:${name}`);
      const r = await legacy.execute(input, ctx);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }
    case "list_lead_documents":
      return await toolListLeadDocuments(input, ctx);
    case "import_leads_from_attachment":
      return await toolImportLeadsFromAttachment(input, ctx);
    case "advance_lead_stage":
      return await toolAdvanceLeadStage(input, ctx);
    case "kixie_call":
      return await toolKixieCall(input, ctx);
    case "kixie_send_sms":
      return await toolKixieSendSms(input, ctx);
    case "texttorrent_send":
      return await toolTextTorrentSend(input, ctx);
    case "texttorrent_blast":
      return await toolTextTorrentBlast(input, ctx);
    case "texttorrent_inbox_reply":
      return await toolTextTorrentInboxReply(input, ctx);
    case "texttorrent_create_list":
      return await toolTextTorrentCreateList(input, ctx);
    case "texttorrent_add_contact":
      return await toolTextTorrentAddContact(input, ctx);
    case "texttorrent_block":
      return await toolTextTorrentBlock(input, ctx);
    case "texttorrent_unblock":
      return await toolTextTorrentUnblock(input, ctx);
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}

/**
 * NL-CRM bridge: operator says "Bennett just churned" -> Bravo calls
 * this with {lead_id, event_type: "contract_ended"} -> engine moves
 * the lead's stage, emits BRAVO_LEAD_AUTO_BUMPED, revalidates the
 * dashboard cache.
 *
 * This is preferred over update_record({stage: "..."}) because it
 * runs through the engine: archived-lead bypass kicks in, from-set
 * gates protect against accidental backflow on regular leads, and
 * the timeline gets a row with the canonical reason code (not just
 * a generic field-changed entry).
 *
 * The tool is OASIS-tenant aware via dispatchOasisOnlyEvent — on
 * SunBiz / other tenants it returns no_rule, which is the correct
 * shape (those tenants use a different lifecycle and have their
 * own dispatcher entry points).
 */
async function toolAdvanceLeadStage(
  input: unknown,
  ctx: { tenantId: string },
): Promise<unknown> {
  const args = (input || {}) as { lead_id?: string; event_type?: string };
  const leadId = String(args.lead_id || "").trim();
  const eventType = String(args.event_type || "").trim();
  if (!leadId) throw new Error("missing_lead_id");
  if (!eventType) throw new Error("missing_event_type");

  // Whitelist matches the API route's OASIS_OPERATOR_TRIGGERABLE so
  // the agent can't synthesize a transition the operator UI couldn't
  // also fire. Keeps webhook-only events (outbound_email_sent, etc.)
  // off the table.
  const ALLOWED: ReadonlySet<OasisLeadStageEvent["type"]> = new Set([
    "discovery_call_scheduled",
    "lead_qualified",
    "proposal_sent",
    "proposal_viewed",
    "contract_signed",
    "onboarding_complete",
    "lead_replied_negative",
    "contract_ended",
    "manual_outreach_started",
    "manual_archive",
  ]);
  if (!ALLOWED.has(eventType as OasisLeadStageEvent["type"])) {
    throw new Error(`event_type_not_allowed:${eventType}`);
  }

  // Dispatcher owns cache invalidation now (lib/lead-stage-dispatcher
  // → invalidateLeadStagePaths) so both the UI button path and this
  // chat-driven path get the same kanban refresh without duplicating
  // the revalidatePath calls in two places.
  const result = await dispatchOasisOnlyEvent({
    type: eventType as OasisLeadStageEvent["type"],
    tenantId: ctx.tenantId,
    leadId,
  });

  return {
    fired: result.fired,
    ...(result.fired
      ? {
          from: result.from,
          to: result.to,
          reason: result.reasonCode,
          summary: `Lead moved from ${result.from} -> ${result.to} (${result.reasonCode}).`,
        }
      : {
          reason: result.reason,
          summary:
            result.reason === "stage_blocked"
              ? "No-op: that transition isn't allowed from the lead's current stage."
              : result.reason === "not_found"
                ? "No-op: lead not found (already deleted or wrong tenant)."
                : "No-op: stage engine declined the event.",
        }),
  };
}

// ----------------------------------------------------------------------------
// Records tools — delegate to lib/manifest/data, validate against manifest
// ----------------------------------------------------------------------------

async function resolveEntity(tenantId: string, entityName: string) {
  const db = getServiceSupabase();
  const tenantRow = await db
    .from("tenants")
    .select("slug, custom_fields")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantRow.error || !tenantRow.data) throw new Error("tenant_not_found");
  const slug = resolveClientProfileSlug(tenantRow.data) || tenantRow.data.slug;
  if (!slug) throw new Error("manifest_slug_missing");
  const manifest = await getManifest(slug);
  if (!manifest) throw new Error("tenant_manifest_missing");
  const entityList = manifest.data_model || [];
  const entity = entityList.find(
    (e) => e.name.toLowerCase() === entityName.toLowerCase()
  );
  if (!entity) {
    const avail = entityList.map((e) => e.name).join(", ");
    throw new Error(`unknown_entity:${entityName} (available: ${avail || "none"})`);
  }
  return entity;
}

/**
 * Append one bullet to user_profiles.custom_fields.quick_facts for the
 * authenticated user. Bounded, deduped, per-user — each user only
 * writes their own profile.
 *
 * Bounds (all defensive, not security):
 *   - fact must be a non-empty string ≤ 500 chars after trim
 *   - total quick_facts capped at 8000 chars — once full, returns an
 *     error telling the model to ask the operator to prune in Settings
 *   - exact-line dedupe — if the same bullet exists already, returns
 *     {deduped: true} without writing
 *
 * Backs the "I'll save this to KNOWN FACTS for next time" promise in
 * the cloud system prompt — without this tool the model could only
 * say it would save, not actually do it.
 */
const QUICK_FACTS_MAX_CHARS = 8000;
const QUICK_FACT_MAX_CHARS = 500;
async function toolSaveKnownFact(input: Record<string, unknown>, ctx: ToolContext) {
  const raw = typeof input.fact === "string" ? input.fact.trim() : "";
  if (!raw) throw new Error("empty_fact");
  if (raw.length > QUICK_FACT_MAX_CHARS) {
    throw new Error(`fact_too_long_${QUICK_FACT_MAX_CHARS}_chars_max`);
  }
  const bullet = raw.startsWith("- ") ? raw : `- ${raw}`;

  const db = getServiceSupabase();
  const read = await db
    .from("user_profiles")
    .select("custom_fields")
    .eq("auth_user_id", ctx.authUserId)
    .maybeSingle();
  if (read.error) throw new Error(read.error.message);
  if (!read.data) throw new Error("profile_not_found");

  const cf: Record<string, unknown> = { ...(read.data.custom_fields || {}) };
  const existing =
    typeof cf[PROFILE_CUSTOM_FIELD_KEYS.QUICK_FACTS] === "string"
      ? (cf[PROFILE_CUSTOM_FIELD_KEYS.QUICK_FACTS] as string)
      : "";

  // Exact-line dedupe — strip whitespace per-line, compare normalized.
  const normalized = bullet.trim();
  const alreadyPresent = existing
    .split("\n")
    .map((l) => l.trim())
    .includes(normalized);
  if (alreadyPresent) {
    return { ok: true, deduped: true, saved: bullet };
  }

  const next = existing ? `${existing}\n${bullet}` : bullet;
  if (next.length > QUICK_FACTS_MAX_CHARS) {
    throw new Error(
      `quick_facts_full_${QUICK_FACTS_MAX_CHARS}_chars_max__operator_must_prune_in_settings`,
    );
  }

  cf[PROFILE_CUSTOM_FIELD_KEYS.QUICK_FACTS] = next;
  const upd = await db
    .from("user_profiles")
    .update({ custom_fields: cf })
    .eq("auth_user_id", ctx.authUserId);
  if (upd.error) throw new Error(upd.error.message);

  return { ok: true, saved: bullet, total_chars: next.length };
}

/**
 * Read a custom credential the tenant admin saved at Settings →
 * Custom credentials. Looks up `tenant_integration_credentials` with
 * service="custom" + field_key=lowercase(name). Returns the decrypted
 * value to the tool dispatcher.
 *
 * SAFETY: the returned value flows into the tool_result content, which
 * is part of the model's context window for the rest of the turn. The
 * tool's *prompt* description instructs the model never to echo it
 * back to the user — that's a soft control, not a hard one. For hard
 * isolation we'd have to intercept the value at the send_email /
 * http_post layer and substitute it server-side after the model emits
 * a placeholder. Worth doing next round.
 *
 * For now: the model is told, the operator stays aware they pasted a
 * secret, and the credential is at least never SAVED to the
 * chat_messages transcript (we strip tool_result content before
 * persisting elsewhere — verify in the persistence layer).
 */
/**
 * Structured audit line for credential vault access. Picked up by
 * Vercel log filters (look for "[AUDIT credential_access]") so a
 * tenant admin can pull the access history without a dedicated UI.
 *
 * Why console.warn instead of a DB row: the dashboard repo doesn't
 * own its migrations directly (schema is managed in the empire repo).
 * console.warn is the lowest-friction durable channel — Vercel
 * retains structured logs and they're queryable per deployment.
 * Promoting to a `credential_access_log` table is a tracked
 * follow-up; the JSON shape here is designed to ingest into one
 * cleanly when that lands (action, tenant_id, user_id, target,
 * result, timestamp_iso).
 */
function auditCredentialAccess(args: {
  action: "get_credential" | "add_credential";
  tenantId: string;
  userId: string;
  agentKey: string;
  target: string;
  result: "ok" | "not_found" | "forbidden" | "invalid" | "error";
  errorMessage?: string;
}): void {
  console.warn(
    "[AUDIT credential_access]",
    JSON.stringify({
      ...args,
      timestamp_iso: new Date().toISOString(),
    }),
  );
}

async function toolGetCredential(input: Record<string, unknown>, ctx: ToolContext) {
  const raw = typeof input.name === "string" ? input.name.trim() : "";
  const targetForAudit = raw ? raw.toUpperCase().slice(0, 64) : "(empty)";
  // ADMIN-ONLY (Codex P1 finding, 2026-05-24). The Settings UI for the
  // vault is gated on canManageTenant; the tool must enforce the same
  // gate or a non-admin member (loan_officer, processor, etc.) could
  // extract decrypted secrets via the chat surface. The model is told
  // not to echo credentials, but that's a soft control — the only hard
  // one is refusing to return the value in the first place.
  if (!ctx.isAdmin) {
    auditCredentialAccess({
      action: "get_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "forbidden",
    });
    return {
      found: false,
      forbidden: true,
      hint:
        "Credential vault is admin-only. Ask the tenant owner or an admin to retrieve this credential, or to add you to the admin role under Settings → Team.",
    };
  }
  if (!raw) {
    auditCredentialAccess({
      action: "get_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "invalid",
      errorMessage: "name_required",
    });
    throw new Error("name_required");
  }
  // Same regex as the upload route — refuses anything that wouldn't
  // round-trip with the stored field_key.
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(raw.toUpperCase())) {
    auditCredentialAccess({
      action: "get_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "invalid",
      errorMessage: "invalid_credential_name_format",
    });
    throw new Error("invalid_credential_name_format");
  }
  const fieldKey = raw.toLowerCase();
  const value = await getTenantIntegrationValue(
    ctx.tenantId,
    VAULT_CUSTOM_SERVICE,
    fieldKey,
  );
  if (value === null) {
    auditCredentialAccess({
      action: "get_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "not_found",
    });
    return {
      found: false,
      name: raw.toUpperCase(),
      hint:
        "Credential not in vault. Tell the operator to add it under Settings → Custom credentials using this exact KEY name.",
    };
  }
  auditCredentialAccess({
    action: "get_credential",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentKey: ctx.agentKey,
    target: targetForAudit,
    result: "ok",
  });
  return { found: true, name: raw.toUpperCase(), value };
}

/**
 * Admin-only mirror of toolGetCredential. Lets an admin tell the
 * agent in chat "save this as STRIPE_WEBHOOK_SECRET" and have the
 * agent persist it without the admin navigating to Settings.
 *
 * Same gate as get_credential (ctx.isAdmin); same regex for KEY
 * validation; same audit log. Reuses setTenantIntegrationValue from
 * the integration store so encryption + upsert semantics are
 * identical to what the Settings UI / API route do.
 */
async function toolAddCredential(input: Record<string, unknown>, ctx: ToolContext) {
  const rawName = typeof input.name === "string" ? input.name.trim() : "";
  const rawValue = typeof input.value === "string" ? input.value : "";
  const targetForAudit = rawName ? rawName.toUpperCase().slice(0, 64) : "(empty)";
  if (!ctx.isAdmin) {
    auditCredentialAccess({
      action: "add_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "forbidden",
    });
    return {
      ok: false,
      forbidden: true,
      hint:
        "Adding credentials is admin-only. Ask the tenant owner or an admin to save this credential.",
    };
  }
  if (!rawName) throw new Error("name_required");
  if (!rawValue) throw new Error("value_required");
  const upperName = rawName.toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(upperName)) {
    auditCredentialAccess({
      action: "add_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "invalid",
      errorMessage: "invalid_credential_name_format",
    });
    throw new Error("invalid_credential_name_format");
  }
  if (rawValue.length > 8192) {
    auditCredentialAccess({
      action: "add_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "invalid",
      errorMessage: "value_too_long",
    });
    throw new Error("value_too_long_max_8192");
  }
  const r = await setTenantIntegrationValue({
    tenantId: ctx.tenantId,
    service: VAULT_CUSTOM_SERVICE,
    fieldKey: upperName.toLowerCase(),
    value: rawValue,
    createdBy: null,
  });
  if (!r.ok) {
    auditCredentialAccess({
      action: "add_credential",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentKey: ctx.agentKey,
      target: targetForAudit,
      result: "error",
      errorMessage: r.error,
    });
    throw new Error(r.error);
  }
  auditCredentialAccess({
    action: "add_credential",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentKey: ctx.agentKey,
    target: targetForAudit,
    result: "ok",
  });
  return {
    ok: true,
    name: upperName,
    hint: "Saved to the vault. Future chats can retrieve this via get_credential.",
  };
}

async function toolListRecords(input: Record<string, unknown>, ctx: ToolContext) {
  const entity = String(input.entity || "");
  await resolveEntity(ctx.tenantId, entity);
  const where: Record<string, string | number | boolean | null> = {};
  if (input.filter && typeof input.filter === "object" && !Array.isArray(input.filter)) {
    for (const [k, v] of Object.entries(input.filter as Record<string, unknown>)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        where[k] = v;
      }
    }
  }
  const sort = typeof input.sort === "string" ? input.sort : undefined;
  const limit = Math.max(1, Math.min(Number(input.limit) || 25, 100));
  const result = await dataList({
    tenant_id: ctx.tenantId,
    entity: entity.toLowerCase(),
    where: Object.keys(where).length > 0 ? where : undefined,
    sort,
    limit,
  });
  return {
    count: result.total,
    rows: result.rows.map((r) => ({ id: r.id, ...r.data })),
  };
}

async function toolGetRecord(input: Record<string, unknown>, ctx: ToolContext) {
  const entity = String(input.entity || "");
  const id = String(input.id || "");
  if (!id) throw new Error("id_required");
  await resolveEntity(ctx.tenantId, entity);
  const row = await dataGet({ tenant_id: ctx.tenantId, entity: entity.toLowerCase(), id });
  if (!row) throw new Error("record_not_found");
  return { id: row.id, ...row.data };
}

async function toolListLeadDocuments(
  input: Record<string, unknown>,
  ctx: ToolContext,
) {
  const leadId = String(input.lead_id || "").trim();
  if (!leadId) throw new Error("lead_id_required");
  const docTypeFilter =
    typeof input.doc_type === "string" && input.doc_type.trim()
      ? input.doc_type.trim().toLowerCase()
      : null;

  const db = getServiceSupabase();
  let query = db
    .from("lead_documents")
    .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at, metadata")
    .eq("tenant_id", ctx.tenantId)
    .eq("lead_id", leadId)
    .is("metadata->>deleted_at", null) // Batch 5: exclude soft-deleted
    .order("uploaded_at", { ascending: false })
    .limit(50);
  if (docTypeFilter) query = query.eq("doc_type", docTypeFilter);
  const { data, error } = await query;
  if (error) throw new Error(`lead_documents_query_failed: ${error.message}`);
  const rows = (data || []) as Array<{
    id: string;
    filename: string;
    mime_type: string | null;
    size_bytes: number | null;
    doc_type: string;
    uploaded_by: string | null;
    uploaded_at: string;
    metadata: Record<string, unknown> | null;
  }>;

  return {
    lead_id: leadId,
    count: rows.length,
    documents: rows.map((d) => ({
      id: d.id,
      filename: d.filename,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      doc_type: d.doc_type,
      uploaded_by: d.uploaded_by,
      uploaded_at: d.uploaded_at,
      // Surface the form field name so the model can correlate to the
      // form definition when the operator asks "is the bank statements
      // field still missing".
      form_field: ((d.metadata || {}) as Record<string, unknown>).field_name ?? null,
    })),
  };
}

async function toolImportLeadsFromAttachment(
  input: Record<string, unknown>,
  ctx: ToolContext,
) {
  const attachmentId = String(input.attachment_id || "").trim();
  if (!attachmentId) throw new Error("attachment_id_required");
  const dryRun = input.dry_run === true;
  const { row, text } = await downloadChatAttachmentText({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    attachmentId,
  });
  const parsed = parseLeadImportCsv(text);
  const recognizedColumns = parsed.colMap.filter(Boolean).length;
  if (recognizedColumns === 0 || parsed.mapped.length === 0) {
    throw new Error("no_recognized_leads_in_attachment");
  }
  if (dryRun) {
    return {
      dry_run: true,
      attachment_id: attachmentId,
      filename: row.filename,
      recognized_columns: recognizedColumns,
      parsed_rows: parsed.mapped.length,
      header_row_index: parsed.headerRowIndex,
      skipped_noise_rows: parsed.skippedNoiseRows,
      section_labels: parsed.sectionLabels,
      sample: parsed.mapped.slice(0, 5),
    };
  }

  const result = await importLeadsForTenant({
    tenantId: ctx.tenantId,
    rows: parsed.mapped,
    defaultSource: `chat_attachment:${row.filename}`,
  });
  if (!result.ok) throw new Error(`${result.error}${result.detail ? `: ${result.detail}` : ""}`);
  return {
    attachment_id: attachmentId,
    filename: row.filename,
    recognized_columns: recognizedColumns,
    parsed_rows: parsed.mapped.length,
    inserted: result.inserted,
    skipped_duplicate: result.skipped_duplicate,
    skipped_malformed: result.skipped_malformed,
    duplicate_keys: result.duplicate_keys.slice(0, 10),
    errors: result.errors.slice(0, 10),
  };
}

async function toolSearchRecords(input: Record<string, unknown>, ctx: ToolContext) {
  const entity = String(input.entity || "");
  const query = String(input.query || "").trim();
  if (!query || query.length < 2) throw new Error("query_too_short");
  const limit = Math.max(1, Math.min(Number(input.limit) || 10, 25));
  await resolveEntity(ctx.tenantId, entity);

  // No FTS on tenant_records.data (JSONB) — fetch a wide window then
  // substring-match in app code. Bounded at 200 rows so the memory cost
  // is fixed; if the operator has more, they should narrow via filter.
  const result = await dataList({
    tenant_id: ctx.tenantId,
    entity: entity.toLowerCase(),
    limit: 200,
  });
  const needle = query.toLowerCase();
  const matches = result.rows.filter((r) => {
    try {
      return JSON.stringify(r.data).toLowerCase().includes(needle);
    } catch {
      return false;
    }
  });
  return {
    count: matches.length,
    rows: matches.slice(0, limit).map((r) => ({ id: r.id, ...r.data })),
  };
}

// ----------------------------------------------------------------------------
// SunBiz comms tools (Phase 3d, 2026-06-02) — Kixie + TextTorrent.
//
// Sends (call / sms / blast / inbox_reply) are dry-run gated via isDryRun().
// List management (create_list / add_contact / block / unblock) runs live —
// it never contacts a prospect, only shapes TT-side data — but still
// requires the tenant's TT credentials, so it no-ops until those are wired.
// Thrown TextTorrentError / KixieError propagate to executeTool's wrapper,
// which surfaces them to the model as a tool error.
// ----------------------------------------------------------------------------

function leadIdArg(input: Record<string, unknown>): string | null {
  return typeof input.lead_id === "string" && input.lead_id.trim() ? input.lead_id.trim() : null;
}

/** Resolve a lead's stored phone (normalized E.164) from tenant_records. */
async function resolveLeadPhone(tenantId: string, leadId: string): Promise<string | null> {
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_records")
    .select("data")
    .eq("id", leadId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const data = (r.data as { data?: Record<string, unknown> } | null)?.data || {};
  return normalizePhoneE164(typeof data.phone === "string" ? data.phone : "");
}

/** 3-tier Kixie agent email: per-user override → profile email → tenant default. */
async function resolveKixieAgentEmail(ctx: ToolContext, fallback: string | undefined): Promise<string> {
  let email = "";
  try {
    const ov = await getUserIntegrationValue(ctx.tenantId, ctx.userId, "kixie", "kixie_agent_email");
    if (ov) email = ov;
  } catch {
    /* soft-fail */
  }
  if (!email) {
    try {
      const db = getServiceSupabase();
      const r = await db
        .from("user_profiles")
        .select("email")
        .eq("auth_user_id", ctx.authUserId)
        .maybeSingle();
      const e = (r.data as { email?: string | null } | null)?.email;
      if (e) email = e;
    } catch {
      /* soft-fail */
    }
  }
  return email || fallback || "";
}

/** Best-effort timeline log for chat-initiated sends. Never throws. */
async function logCommsInteraction(args: {
  tenantId: string;
  leadId: string | null;
  toPhone: string;
  preview: string;
  userId: string;
  type: string;
  channel: string;
  provider: string;
  dryRun: boolean;
}) {
  try {
    const db = getServiceSupabase();
    await db.from("lead_interactions").insert({
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      type: args.type,
      channel: args.channel,
      direction: "outbound",
      agent_source: "chat_tool",
      to_phone: args.toPhone,
      content_preview: args.preview.slice(0, 1024),
      actor_user_id: args.userId,
      metadata: { provider: args.provider, dry_run: args.dryRun },
    });
  } catch (err) {
    console.error("[cloud-tool comms] interaction log failed", err);
  }
}

async function toolKixieCall(input: Record<string, unknown>, ctx: ToolContext) {
  const leadId = leadIdArg(input);
  let phone = normalizePhoneE164(typeof input.target === "string" ? input.target : "");
  if (!phone && leadId) phone = await resolveLeadPhone(ctx.tenantId, leadId);
  if (!phone) throw new Error("no_phone: pass target (E.164) or a lead_id with a stored phone.");
  const displayName =
    typeof input.display_name === "string" && input.display_name.trim()
      ? input.display_name.trim()
      : "Outbound call";

  if (isDryRun()) {
    await logCommsInteraction({ tenantId: ctx.tenantId, leadId, toPhone: phone, preview: `Call ${phone}`, userId: ctx.userId, type: "call_initiated", channel: "phone", provider: "kixie", dryRun: true });
    return { ok: true, dry_run: true, would_call: { target: phone, lead_id: leadId } };
  }
  const creds = await getKixieCredentials(ctx.tenantId);
  const agentEmail = await resolveKixieAgentEmail(ctx, creds.defaultAgentEmail);
  if (!agentEmail) throw new Error("no_agent_email: set your Kixie agent email in Settings → Personal integrations.");
  await kixieMakeCall(creds, { target: phone, agentEmail, displayName, leadId: leadId ?? undefined });
  await logCommsInteraction({ tenantId: ctx.tenantId, leadId, toPhone: phone, preview: `Call initiated by ${agentEmail}`, userId: ctx.userId, type: "call_initiated", channel: "phone", provider: "kixie", dryRun: false });
  return { ok: true, dry_run: false, target: phone, agent_email: agentEmail };
}

async function toolKixieSendSms(input: Record<string, unknown>, ctx: ToolContext) {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new Error("message_required");
  const leadId = leadIdArg(input);
  let phone = normalizePhoneE164(typeof input.target === "string" ? input.target : "");
  if (!phone && leadId) phone = await resolveLeadPhone(ctx.tenantId, leadId);
  if (!phone) throw new Error("no_phone: pass target (E.164) or a lead_id with a stored phone.");

  if (isDryRun()) {
    await logCommsInteraction({ tenantId: ctx.tenantId, leadId, toPhone: phone, preview: message, userId: ctx.userId, type: "sms_sent", channel: "sms", provider: "kixie", dryRun: true });
    return { ok: true, dry_run: true, would_send: { target: phone, message, lead_id: leadId } };
  }
  if (await isPhoneOptedOut(ctx.tenantId, phone)) {
    throw new Error("opted_out: recipient previously replied STOP — send blocked.");
  }
  const creds = await getKixieCredentials(ctx.tenantId);
  const agentEmail = await resolveKixieAgentEmail(ctx, creds.defaultAgentEmail);
  if (!agentEmail) throw new Error("no_agent_email: set your Kixie agent email in Settings → Personal integrations.");
  await kixieSendSms(creds, { target: phone, message, agentEmail, leadId: leadId ?? undefined });
  await logCommsInteraction({ tenantId: ctx.tenantId, leadId, toPhone: phone, preview: message, userId: ctx.userId, type: "sms_sent", channel: "sms", provider: "kixie", dryRun: false });
  return { ok: true, dry_run: false, target: phone };
}

async function toolTextTorrentSend(input: Record<string, unknown>, ctx: ToolContext) {
  const number = normalizePhoneE164(typeof input.number === "string" ? input.number : "");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!number) throw new Error("no_phone: number must be E.164.");
  if (!message) throw new Error("message_required");

  if (isDryRun()) {
    await logCommsInteraction({ tenantId: ctx.tenantId, leadId: null, toPhone: number, preview: message, userId: ctx.userId, type: "sms_sent", channel: "sms", provider: "texttorrent", dryRun: true });
    return { ok: true, dry_run: true, would_send: { number, message } };
  }
  if (await isPhoneOptedOut(ctx.tenantId, number)) {
    throw new Error("opted_out: recipient previously replied STOP — send blocked.");
  }
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  await ttSendSms(creds, { number, message });
  await logCommsInteraction({ tenantId: ctx.tenantId, leadId: null, toPhone: number, preview: message, userId: ctx.userId, type: "sms_sent", channel: "sms", provider: "texttorrent", dryRun: false });
  return { ok: true, dry_run: false, number };
}

async function toolTextTorrentInboxReply(input: Record<string, unknown>, ctx: ToolContext) {
  const number = normalizePhoneE164(typeof input.number === "string" ? input.number : "");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!number) throw new Error("no_phone: number must be E.164.");
  if (!message) throw new Error("message_required");

  if (isDryRun()) {
    await logCommsInteraction({ tenantId: ctx.tenantId, leadId: null, toPhone: number, preview: message, userId: ctx.userId, type: "sms_sent", channel: "sms", provider: "texttorrent", dryRun: true });
    return { ok: true, dry_run: true, would_send: { number, message } };
  }
  if (await isPhoneOptedOut(ctx.tenantId, number)) {
    throw new Error("opted_out: recipient previously replied STOP — send blocked.");
  }
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  await ttReplyToThread(creds, { number, message });
  await logCommsInteraction({ tenantId: ctx.tenantId, leadId: null, toPhone: number, preview: message, userId: ctx.userId, type: "sms_sent", channel: "sms", provider: "texttorrent", dryRun: false });
  return { ok: true, dry_run: false, number };
}

async function toolTextTorrentBlast(input: Record<string, unknown>, ctx: ToolContext) {
  // Owner/admin only (Codex P1, 2026-06-02) — mirrors the dashboard campaign
  // endpoint's gate. A blast hits many recipients; a non-admin Helios user
  // must not be able to launch one via chat.
  if (!ctx.isAdmin) {
    throw new Error("forbidden: launching a bulk campaign is owner/admin only.");
  }
  const listId = typeof input.list_id === "string" ? input.list_id.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const scheduledTime =
    typeof input.scheduled_time === "string" && input.scheduled_time.trim()
      ? input.scheduled_time.trim()
      : undefined;
  if (!listId) throw new Error("list_id_required");
  if (!message) throw new Error("message_required");

  if (isDryRun()) {
    return { ok: true, dry_run: true, would_create: { list_id: listId, message, scheduled_time: scheduledTime } };
  }
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  const r = await ttCreateCampaign(creds, { list_id: listId, message, scheduled_time: scheduledTime });
  return { ok: true, dry_run: false, campaign: r.data };
}

async function toolTextTorrentCreateList(input: Record<string, unknown>, ctx: ToolContext) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("name_required");
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  const r = await ttCreateList(creds, name);
  return { ok: true, list: r.data };
}

async function toolTextTorrentAddContact(input: Record<string, unknown>, ctx: ToolContext) {
  const firstName = typeof input.first_name === "string" ? input.first_name.trim() : "";
  const number = normalizePhoneE164(typeof input.number === "string" ? input.number : "");
  const listId = typeof input.list_id === "string" ? input.list_id.trim() : "";
  if (!firstName) throw new Error("first_name_required");
  if (!number) throw new Error("no_phone: number must be E.164.");
  if (!listId) throw new Error("list_id_required");
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  const r = await ttAddContact(creds, {
    first_name: firstName,
    number,
    list_id: listId,
    last_name: typeof input.last_name === "string" ? input.last_name : undefined,
    email: typeof input.email === "string" ? input.email : undefined,
    company: typeof input.company === "string" ? input.company : undefined,
  });
  return { ok: true, contact: r.data };
}

async function toolTextTorrentBlock(input: Record<string, unknown>, ctx: ToolContext) {
  const contactId = typeof input.contact_id === "string" && input.contact_id.trim() ? input.contact_id.trim() : undefined;
  const number = typeof input.number === "string" && input.number.trim() ? input.number.trim() : undefined;
  if (!contactId && !number) throw new Error("contact_id_or_number_required");
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  await ttBlockContact(creds, { contact_id: contactId, number });
  return { ok: true, blocked: contactId || number };
}

async function toolTextTorrentUnblock(input: Record<string, unknown>, ctx: ToolContext) {
  const ids = Array.isArray(input.contact_ids)
    ? (input.contact_ids as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  if (ids.length === 0) throw new Error("contact_ids_required");
  const creds = await getTextTorrentCredentials(ctx.tenantId);
  await ttUnblockContact(creds, ids);
  return { ok: true, unblocked_count: ids.length };
}

// create_record / update_record / delete_record are dispatched directly to
// runAction in agent-actions.ts (see switch above) — no per-tool wrapper
// needed here. That keeps validation, manifest-scoping, and audit-logging
// in one place rather than duplicating them per call site.

// ----------------------------------------------------------------------------
// HTTP tools — open-web access with safety rails
// ----------------------------------------------------------------------------

function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unsupported_protocol");
  }
  // Block obvious SSRF targets — agents on the public dashboard should never
  // need to hit our own internal infra. Cloud-tool calls are explicitly
  // for public web reads.
  const host = parsed.hostname.toLowerCase();
  const blocked = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "169.254.169.254", // AWS/Azure/GCP IMDS v1 + v2
    "fd00:ec2::254",   // AWS IMDS v6
    "metadata.google.internal",
    "metadata.azure.com",
  ];
  if (blocked.includes(host)) throw new Error("blocked_host");
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new Error("blocked_host");
  }
  // Private IP ranges (IPv4) — quick string check, not exhaustive but
  // covers 10/8, 172.16/12, 192.168/16, 169.254/16 link-local.
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    throw new Error("blocked_private_ip");
  }
  // IPv6 unique-local / loopback / link-local
  if (/^(::ffff:0?7f\.|fc|fd|fe[89ab]|::1$)/i.test(host)) {
    throw new Error("blocked_private_ip");
  }
  return parsed;
}

/**
 * DNS-aware SSRF check. The synchronous assertSafeUrl above blocks
 * literal hostnames + IPs but a public hostname like `evil.com` that
 * resolves to 127.0.0.1 or 169.254.169.254 would slip through.
 *
 * Resolves the hostname via Node's dns.lookup and rejects when any
 * resolved address falls in a private / loopback / IMDS range. Called
 * from fetchWithCap right before issuing the request so the resolved
 * IP we check IS the IP fetch will connect to (modulo TOCTOU — rare in
 * practice for this use case; Codex flagged DNS rebinding as a
 * theoretical risk but the cost of full pin-and-connect is too high
 * for a chat tool's latency budget).
 *
 * 2026-05-16 Codex review finding #6 hardening.
 */
async function assertResolvedIpIsPublic(host: string): Promise<void> {
  // Skip when the host is already a literal IP — assertSafeUrl above
  // handled it.
  if (/^[0-9.]+$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host)) return;
  let lookup: typeof import("dns/promises").lookup;
  try {
    ({ lookup } = await import("dns/promises"));
  } catch {
    // dns module unavailable (edge runtime, etc.) — fall back to
    // hostname-only check. This route declares runtime='nodejs' so
    // we expect the import to succeed in production.
    return;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // DNS failed — let fetch surface the network error rather than
    // pretending we know something about the host.
    return;
  }
  for (const a of addrs) {
    const ip = a.address.toLowerCase();
    if (
      ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0" ||
      /^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) ||
      /^169\.254\./.test(ip) ||
      /^(fc|fd|fe[89ab]|::1)/i.test(ip)
    ) {
      throw new Error("blocked_resolved_private_ip");
    }
  }
}

function sanitizeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const lower = k.toLowerCase();
    // Block hop-by-hop, auth-shaped, and cloud-credential-carrying
    // headers — operator's API key + AWS/GCP/Azure metadata-service
    // tokens must NEVER be leaked into outbound requests the model
    // controls. 2026-05-16 Codex review finding #6 expanded the
    // block list beyond just cookie / host / connection.
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "cookie" ||
      lower === "authorization" ||
      lower === "proxy-authorization" ||
      lower === "x-aws-ec2-metadata-token" ||
      lower.startsWith("x-amz-") ||
      lower.startsWith("x-goog-") ||
      lower.startsWith("x-ms-")
    ) {
      continue;
    }
    out[k] = v.slice(0, 2048);
  }
  return out;
}

async function fetchWithCap(url: URL, init: RequestInit): Promise<{ status: number; contentType: string; body: string; truncated: boolean }> {
  // DNS-aware SSRF guard — resolves the hostname and rejects if it
  // points at a private / loopback / IMDS address. Defends against
  // attacker-controlled hostnames like `evil.com` that resolve to
  // 169.254.169.254. 2026-05-16 Codex review hardening.
  await assertResolvedIpIsPublic(url.hostname.toLowerCase());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    // redirect: 'manual' so a public URL can't 302 us into an internal
    // address. 3xx responses surface to the model as-is; if the
    // operator/agent wants to follow, they make a new tool call with
    // the new URL (which re-runs SSRF checks).
    const res = await fetch(url.toString(), { ...init, signal: controller.signal, redirect: "manual" });
    const contentType = res.headers.get("content-type") || "";
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, contentType, body: "", truncated: false };
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > HTTP_BODY_CAP_BYTES) {
        truncated = true;
        try { await reader.cancel(); } catch {}
        break;
      }
      body += decoder.decode(value, { stream: true });
    }
    return { status: res.status, contentType, body, truncated };
  } finally {
    clearTimeout(timer);
  }
}

async function toolHttpGet(input: Record<string, unknown>) {
  const url = assertSafeUrl(String(input.url || ""));
  const headers = sanitizeHeaders(input.headers);
  const r = await fetchWithCap(url, { method: "GET", headers });
  return {
    status: r.status,
    content_type: r.contentType,
    body: r.body.slice(0, 200_000), // cap returned-to-model size separately
    truncated: r.truncated,
    note: r.truncated
      ? "Response body was truncated at 5MB; only the first 200KB are shown to the model."
      : undefined,
  };
}

async function toolHttpPost(input: Record<string, unknown>) {
  const url = assertSafeUrl(String(input.url || ""));
  const headers = sanitizeHeaders(input.headers);
  if (!headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const r = await fetchWithCap(url, { method: "POST", headers, body });
  return {
    status: r.status,
    content_type: r.contentType,
    body: r.body.slice(0, 200_000),
    truncated: r.truncated,
    note: r.truncated
      ? "Response body was truncated at 5MB; only the first 200KB are shown to the model."
      : undefined,
  };
}

// ----------------------------------------------------------------------------
// Human-readable summaries for the chat UI tool-activity line
// ----------------------------------------------------------------------------

function humanSummary(name: string, input: Record<string, unknown>, data: unknown): string {
  switch (name) {
    case "read_brain_doc": {
      const d = data as { path?: string; truncated?: boolean };
      return `read ${d.path || String(input.path)}${d.truncated ? " (truncated)" : ""}`;
    }
    case "search_memory": {
      const d = data as { count?: number };
      return `searched memory for "${String(input.query)}" - ${d.count || 0} match${d.count === 1 ? "" : "es"}`;
    }
    case "save_known_fact": {
      const d = data as { saved?: string; deduped?: boolean };
      if (d.deduped) return `known fact already saved (deduped)`;
      const preview = (d.saved || String(input.fact || "")).slice(0, 80);
      return `saved known fact: "${preview}${preview.length >= 80 ? "…" : ""}"`;
    }
    case "get_credential": {
      const d = data as { found?: boolean; forbidden?: boolean };
      const name = String(input.name || "?").toUpperCase();
      if (d.forbidden) return `credential ${name} access denied (admin only)`;
      return d.found
        ? `retrieved credential ${name} (value masked)`
        : `credential ${name} not found in vault`;
    }
    case "add_credential": {
      const d = data as { ok?: boolean; forbidden?: boolean };
      const name = String(input.name || "?").toUpperCase();
      if (d.forbidden) return `add credential ${name} denied (admin only)`;
      return d.ok ? `saved credential ${name} to vault` : `add credential ${name} failed`;
    }
    case "web_fetch": {
      const d = data as { status: number };
      return `fetch ${String(input.url).slice(0, 60)} -> ${d.status}`;
    }
    case "list_records": {
      const d = data as { count: number };
      return `listed ${d.count} ${String(input.entity)} row${d.count === 1 ? "" : "s"}`;
    }
    case "get_record":
      return `read ${String(input.entity)} ${String(input.id).slice(0, 8)}…`;
    case "search_records": {
      const d = data as { count: number };
      return `searched ${String(input.entity)} for "${String(input.query)}" — ${d.count} match${d.count === 1 ? "" : "es"}`;
    }
    case "create_record":
    case "update_record":
    case "delete_record": {
      const d = data as { summary?: string };
      return d.summary || `${name.replace("_", " ")} ok`;
    }
    case "http_get": {
      const d = data as { status: number };
      return `GET ${String(input.url).slice(0, 60)} → ${d.status}`;
    }
    case "http_post": {
      const d = data as { status: number };
      return `POST ${String(input.url).slice(0, 60)} → ${d.status}`;
    }
    case "lookup_lead_by_name":
      return `lead lookup: "${String(input.name)}"`;
    case "list_open_leads":
      return `listed open leads`;
    case "integration_status":
      return `checked integrations`;
    case "import_leads_from_attachment": {
      const d = data as { inserted?: number; parsed_rows?: number; dry_run?: boolean };
      return d.dry_run
        ? `parsed ${d.parsed_rows || 0} lead rows from attachment`
        : `imported ${d.inserted || 0} lead rows from attachment`;
    }
    case "kixie_call": {
      const d = data as { dry_run?: boolean; target?: string };
      return `${d.dry_run ? "(dry-run) " : ""}calling ${d.target || String(input.target || input.lead_id || "")} via Kixie`;
    }
    case "kixie_send_sms": {
      const d = data as { dry_run?: boolean; target?: string };
      return `${d.dry_run ? "(dry-run) " : ""}Kixie SMS → ${d.target || String(input.target || input.lead_id || "")}`;
    }
    case "texttorrent_send":
    case "texttorrent_inbox_reply": {
      const d = data as { dry_run?: boolean; number?: string };
      return `${d.dry_run ? "(dry-run) " : ""}TextTorrent SMS → ${d.number || String(input.number || "")}`;
    }
    case "texttorrent_blast": {
      const d = data as { dry_run?: boolean };
      return `${d.dry_run ? "(dry-run) " : ""}TextTorrent blast to list ${String(input.list_id || "")}`;
    }
    case "texttorrent_create_list":
      return `created TextTorrent list "${String(input.name || "")}"`;
    case "texttorrent_add_contact":
      return `added contact to TextTorrent list ${String(input.list_id || "")}`;
    case "texttorrent_block":
      return `blocked TextTorrent contact`;
    case "texttorrent_unblock": {
      const d = data as { unblocked_count?: number };
      return `unblocked ${d.unblocked_count || 0} TextTorrent contact${d.unblocked_count === 1 ? "" : "s"}`;
    }
    default:
      return name;
  }
}

// ============================================================================
// Anthropic tool_use streaming loop
// ============================================================================

export type StreamYield =
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string; ok: boolean }
  /**
   * Deferred tool — the model called a tool marked defer:true. The runner
   * captured the assistant turn (including the tool_use block) into the
   * resume_state below, then exits. The /api/chat route forwards this as an
   * SSE event so the browser can execute the tool locally and POST the
   * result to /api/chat/resume.
   */
  | {
      type: "tool_use_pending";
      tool_use_id: string;
      name: string;
      input: Record<string, unknown>;
      resume_state: ResumeState;
    }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

type AnthropicMessage =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[] };

/**
 * The payload that gets serialized to the browser, hops through the
 * /api/chat/resume route, and seeds the next iteration of the loop with
 * the pre-pause state intact. Contains everything resumeAnthropicTurn()
 * needs to continue the model's session without re-running prior iterations.
 *
 * Security note: this state passes through the browser. v1 trusts the
 * authed dashboard session (replay attacks only let an operator mess with
 * their OWN chat, no cross-tenant blast radius). If /api/chat/resume ever
 * becomes a multi-tenant or public surface, add HMAC signing here so a
 * malicious page can't synthesize states the server didn't issue.
 */
export type ResumeState = {
  /** Anthropic model ID — must match the model that was streaming the pause. */
  model: string;
  /** System prompt the iteration loop was running with. */
  system: string;
  /** Full conversation history, including the assistant turn with the
   *  deferred tool_use block. resumeAnthropicTurn appends the tool_result
   *  block on top before re-opening the stream. */
  history: AnthropicMessage[];
  /** Iteration index the pause happened on; used to enforce the iteration
   *  cap across the resume boundary. */
  iteration: number;
  /** Running totals so the resumed turn keeps incrementing usage instead
   *  of resetting to zero. */
  totalIn: number;
  totalOut: number;
  /** Echo of the original request's maxTokens / enableTools — applied to
   *  the resumed call so the second half of the conversation behaves
   *  identically to what would have happened without the pause. */
  maxTokens?: number;
  enableTools?: boolean;
  /** Per-agent tool allowlist from the manifest (Phase D). Same value
   *  the initial /api/chat call resolved. Carried in resume_state so the
   *  resumed turn sees an identical tool palette to the paused turn — if
   *  the operator changed it mid-pause, the change applies on the next
   *  fresh /api/chat call, not on this one. */
  toolPalette?: string[];
  /** Plan vs Build mode at the time of the pause. MUST persist across
   *  resume — otherwise the second half of the turn would unlock write
   *  tools that were filtered out before the pause. The system prompt
   *  overlay is already carried in `system` above; this field re-applies
   *  the tool filter inside runIterationLoop on resume. */
  chatMode?: ChatPlanMode;
  /** Filter-1 (bridge offline) persisted across the pause. Without this,
   *  resume could surface deferred bridge tools that weren't in the
   *  paused turn's palette. */
  excludeDeferredTools?: boolean;
  /** Filter-2 (bridge-advertised capabilities). Persisted so resume
   *  sees the same bridge tool set the original call resolved.
   *  null = no advertisement on record (older bridges). */
  bridgeAdvertisedTools?: string[] | null;
};

export type ToolLoopRequest = {
  apiKey: string;
  model: string;
  system: string;
  /** Conversation history, user-shaped (just role + string content). */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  /** When false, runs a no-tools straight stream (provider-fallback path). */
  enableTools?: boolean;
  /** When true, the deferred (bridge-routed) tools are filtered out of the
   *  palette sent to the model. Use this when the operator's bridge is
   *  offline — without it, the model sees send_email / bash / read_file
   *  in TOOL_DEFINITIONS, calls one, the browser proxy errors
   *  bridge_unreachable, the model retries, etc. Cleaner to tell the
   *  model up front that those tools don't exist this turn. */
  excludeDeferredTools?: boolean;
  /**
   * Per-agent tool allowlist from the tenant's manifest (Phase D).
   * Undefined → no filter; agent gets the full palette (preserves
   * pre-Phase-D behavior for existing tenants).
   * Empty array → agent is chat-only, no tools.
   * Populated → only these tool names get advertised to the model.
   *
   * Applied AFTER excludeDeferredTools — bridge-routed tools still get
   * filtered out when bridge is offline, even if they're in the palette.
   */
  toolPalette?: string[];
  /**
   * Phase F — bridge-advertised tool registry. The operator's local
   * bridge daemon reports which tools its installation actually has
   * (bravo_cli/bridge_tools.py:list_available_tools) on each heartbeat.
   * /api/chat reads bridge_pairings.tool_capabilities and passes it
   * here. null → no advertisement on record yet (older bridge daemons
   * or never-pinged pairings); runner falls back to the full bridge
   * tool palette in TOOL_DEFINITIONS. Empty array semantics are NOT
   * used here — null is the "no filter" signal.
   *
   * Only narrows defer:true tools. Cloud tools (defer:false) are
   * unaffected — they execute server-side on Vercel, not the bridge.
   */
  bridgeAdvertisedTools?: string[] | null;
  /**
   * Plan vs Build mode (2026-05-22, OpenCode-style chat affordance).
   *
   * "plan" → filter to the read-only allowlist in
   *   lib/chat-modes/plan-mode.ts AND append the PLAN_MODE_PROMPT_OVERLAY
   *   to the system prompt. Agent can read/research but cannot write.
   * "build" or undefined → no change; agent has full access to whatever
   *   tool list the other filters produce.
   *
   * Applied LAST in the filter chain — plan mode overrides anything
   * upstream because its safety contract is the most restrictive.
   */
  chatMode?: ChatPlanMode;
};

export async function* streamAnthropicWithTools(
  req: ToolLoopRequest,
  ctx: ToolContext
): AsyncGenerator<StreamYield> {
  // Convert flat-string history → Anthropic content-block format. The
  // iteration helper handles the rest (initial call, tool dispatch,
  // deferred-tool pause/resume).
  const history: AnthropicMessage[] = req.messages
    .filter((m) => m.content && m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }) as AnthropicMessage);

  // Plan mode adjusts both the system prompt AND the tool filter. Apply
  // the prompt overlay HERE so the model sees the rules from turn 0; the
  // tool filter is applied inside runIterationLoop alongside the other
  // filters (palette / bridge-advertised / defer).
  const mode = normalizeMode(req.chatMode);
  const effectiveSystem = composePlanSystemPrompt(req.system, mode);
  yield* runIterationLoop({
    apiKey: req.apiKey,
    model: req.model,
    system: effectiveSystem,
    maxTokens: req.maxTokens,
    enableTools: req.enableTools,
    excludeDeferredTools: req.excludeDeferredTools,
    toolPalette: req.toolPalette,
    bridgeAdvertisedTools: req.bridgeAdvertisedTools,
    chatMode: mode,
    history,
    startIter: 0,
    startTotalIn: 0,
    startTotalOut: 0,
    ctx,
  });
}

/**
 * Resume a paused tool_use loop. Called by /api/chat/resume after the
 * browser has executed a deferred tool (e.g., via the bridge proxy at
 * localhost:9100/exec-tool) and POSTed back its result.
 *
 * Takes the ResumeState the runner emitted before pausing + the
 * tool_result the client produced. Appends the tool_result block onto
 * the message history and continues the iteration loop from where it
 * left off — same iteration cap, same running token totals.
 */
export async function* resumeAnthropicTurn(
  resume: ResumeState,
  toolUseId: string,
  toolResult: { content: string; is_error: boolean },
  ctx: ToolContext,
  apiKey: string,
): AsyncGenerator<StreamYield> {
  const history: AnthropicMessage[] = [...resume.history];
  // Append the user-side tool_result block that the browser produced.
  history.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: toolResult.content,
        is_error: toolResult.is_error,
      },
    ],
  });
  yield* runIterationLoop({
    apiKey,
    model: resume.model,
    system: resume.system,
    maxTokens: resume.maxTokens,
    enableTools: resume.enableTools,
    toolPalette: resume.toolPalette,
    // Re-apply the chatMode tool filter on resume. The system prompt
    // overlay is already baked into resume.system; this carries the
    // tool-filter half of the plan-mode contract across the pause.
    chatMode: resume.chatMode,
    // Carry the bridge-availability + defer filters across the pause
    // too. Without these, the resume iteration would compute
    // activeTools from a fresh-args path that defaulted both to
    // undefined — re-broadening the palette mid-turn. (Codex #8.)
    excludeDeferredTools: resume.excludeDeferredTools,
    bridgeAdvertisedTools: resume.bridgeAdvertisedTools,
    history,
    startIter: resume.iteration + 1,
    startTotalIn: resume.totalIn,
    startTotalOut: resume.totalOut,
    ctx,
  });
}

type OpenAICompatibleProvider = "openai" | "openrouter";

type OpenAICompatibleMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAICompatibleToolLoopRequest = Omit<
  ToolLoopRequest,
  "bridgeAdvertisedTools" | "excludeDeferredTools"
> & {
  provider: OpenAICompatibleProvider;
};

export async function* streamOpenAICompatibleWithTools(
  req: OpenAICompatibleToolLoopRequest,
  ctx: ToolContext,
): AsyncGenerator<StreamYield> {
  const history: OpenAICompatibleMessage[] = req.messages
    .filter((m) => m.content && m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }) as OpenAICompatibleMessage);
  const mode = normalizeMode(req.chatMode);
  const system = composePlanSystemPrompt(req.system, mode);
  const activeTools = resolveActiveTools({
    toolPalette: req.toolPalette,
    chatMode: mode,
    // OpenAI-compatible resume for bridge-deferred tools is not wired yet.
    // Keep this path cloud-safe instead of advertising tools it cannot resume.
    forceExcludeDeferred: true,
  });
  let totalIn = 0;
  let totalOut = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [{ role: "system", content: system }, ...history],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.provider === "openai") {
      body.max_completion_tokens = req.maxTokens ?? 4096;
    } else {
      body.max_tokens = req.maxTokens ?? 4096;
    }
    if (req.enableTools !== false && activeTools.length > 0) {
      body.tools = activeTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
      body.tool_choice = "auto";
    }

    const res = await fetchWithRetry(openAICompatibleUrl(req.provider), {
      method: "POST",
      headers: openAICompatibleHeaders(req.provider, req.apiKey),
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const detail = await safeText(res);
      yield {
        type: "error",
        message:
          res.status >= 500 || res.status === 429
            ? `provider_temporarily_unavailable:${req.provider}_${res.status}`
            : `${req.provider}_${res.status}:${detail}`,
      };
      return;
    }

    let assistantText = "";
    let finishReason: string | null = null;
    const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

    for await (const ev of parseSSE(res.body)) {
      const data = asSSERecord(ev.data);
      if (!data) continue;
      const choice = firstSSERecord(data.choices);
      const delta = asSSERecord(choice?.delta);
      const text = delta?.content;
      if (typeof text === "string" && text.length > 0) {
        assistantText += text;
        yield { type: "delta", text };
      }
      for (const rawCall of asSSEArray(delta?.tool_calls)) {
        const call = asSSERecord(rawCall);
        if (!call) continue;
        const index = typeof call.index === "number" ? call.index : toolBuffers.size;
        const fn = asSSERecord(call.function);
        const prev = toolBuffers.get(index) || { id: "", name: "", args: "" };
        toolBuffers.set(index, {
          id: typeof call.id === "string" && call.id ? call.id : prev.id,
          name: typeof fn?.name === "string" && fn.name ? fn.name : prev.name,
          args: prev.args + (typeof fn?.arguments === "string" ? fn.arguments : ""),
        });
      }
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const usage = asSSERecord(data.usage);
      if (usage) {
        totalIn = numberOr(usage.prompt_tokens, totalIn);
        totalOut = numberOr(usage.completion_tokens, totalOut);
      }
    }

    const toolUses = [...toolBuffers.values()]
      .filter((tu) => tu.name.length > 0)
      .map((tu, index) => ({
        id: tu.id || `tool_${iter}_${index}`,
        name: tu.name,
        input: parseToolArgs(tu.args),
        rawArgs: tu.args || "{}",
      }));
    if (toolUses.length === 0 || finishReason !== "tool_calls") {
      yield { type: "done", inputTokens: totalIn, outputTokens: totalOut };
      return;
    }

    const allowedToolNames = new Set(activeTools.map((t) => t.name));
    history.push({
      role: "assistant",
      content: assistantText || null,
      tool_calls: toolUses.map((tu) => ({
        id: tu.id,
        type: "function" as const,
        function: { name: tu.name, arguments: tu.rawArgs },
      })),
    });

    for (const tu of toolUses) {
      if (!allowedToolNames.has(tu.name)) {
        const content = JSON.stringify({
          error: "tool_not_allowed_in_current_mode",
          tool: tu.name,
          hint:
            mode === "plan"
              ? `${tu.name} is unavailable in plan mode. Run /build to restore the full tool registry.`
              : `${tu.name} is not in the current agent's tool palette.`,
        });
        history.push({ role: "tool", tool_call_id: tu.id, content });
        yield {
          type: "tool_result",
          name: tu.name,
          ok: false,
          summary: `${tu.name} blocked - not in active tool palette`,
        };
        continue;
      }
      yield { type: "tool_use", name: tu.name, input: tu.input };
      const result = await executeTool(tu.name, tu.input, ctx);
      yield {
        type: "tool_result",
        name: tu.name,
        summary: result.summary,
        ok: !result.is_error,
      };
      history.push({ role: "tool", tool_call_id: tu.id, content: result.content });
    }
  }

  yield {
    type: "error",
    message: `tool_loop_exhausted_after_${MAX_TOOL_ITERATIONS}_iterations`,
  };
}

function openAICompatibleUrl(provider: OpenAICompatibleProvider): string {
  return provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
}

function openAICompatibleHeaders(
  provider: OpenAICompatibleProvider,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://oasisai.work";
    headers["X-Title"] = "OASIS Agent Command Center";
  }
  return headers;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function firstSSERecord(value: unknown): Record<string, unknown> | null {
  return asSSERecord(asSSEArray(value)[0]);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

type IterationLoopArgs = {
  apiKey: string;
  model: string;
  system: string;
  maxTokens?: number;
  enableTools?: boolean;
  excludeDeferredTools?: boolean;
  toolPalette?: string[];
  bridgeAdvertisedTools?: string[] | null;
  /** Plan vs Build mode — when "plan", further filters activeTools to
   *  the PLAN_MODE_TOOL_ALLOWLIST. Undefined = "build" (no filter). */
  chatMode?: ChatPlanMode;
  /** Pre-built history. Mutates as the loop appends turns. */
  history: AnthropicMessage[];
  /** Iteration index to start at (0 for fresh, N+1 for resume). */
  startIter: number;
  startTotalIn: number;
  startTotalOut: number;
  ctx: ToolContext;
};

function resolveActiveTools(args: {
  excludeDeferredTools?: boolean;
  bridgeAdvertisedTools?: string[] | null;
  toolPalette?: string[];
  chatMode?: ChatPlanMode;
  forceExcludeDeferred?: boolean;
}): ToolDef[] {
  let activeTools: ToolDef[] = TOOL_DEFINITIONS;
  if (args.forceExcludeDeferred || args.excludeDeferredTools) {
    activeTools = activeTools.filter((t) => !t.defer);
  } else if (args.bridgeAdvertisedTools !== undefined && args.bridgeAdvertisedTools !== null) {
    const advertised = new Set(args.bridgeAdvertisedTools);
    activeTools = activeTools.filter((t) => !t.defer || advertised.has(t.name));
  }
  if (args.toolPalette !== undefined) {
    const allow = new Set(args.toolPalette);
    activeTools = activeTools.filter((t) => allow.has(t.name));
  }
  if (args.chatMode === "plan") {
    activeTools = filterToolsForMode(activeTools, "plan");
  }
  return activeTools;
}

/**
 * The core Anthropic tool_use streaming loop. Owns the per-iteration
 * fetch → parseSSE → block accumulation → tool-dispatch cycle. Two
 * callers: streamAnthropicWithTools (initial turn) and
 * resumeAnthropicTurn (post-deferred-tool resume).
 *
 * Yields delta/tool_use/tool_result/done/error as documented on
 * StreamYield. NEW for Phase 2: when a tool is marked defer:true on
 * its TOOL_DEFINITIONS entry, the loop captures the in-progress
 * history, yields tool_use_pending with a ResumeState, and exits.
 * Caller resumes via resumeAnthropicTurn.
 */
async function* runIterationLoop(
  args: IterationLoopArgs,
): AsyncGenerator<StreamYield> {
  const { apiKey, model, system, maxTokens, ctx, history } = args;
  const enableTools = args.enableTools !== false;
  // Resolve which tools the model sees this turn. Four filters compose
  // in order — most-restrictive last so the operator's intent wins:
  //
  //   1. excludeDeferredTools (bridge offline)
  //      Drops every bridge-routed tool. Set by /api/chat when no
  //      live bridge_pairings row is present.
  //
  //   2. bridgeAdvertisedTools (Phase F)
  //      When the operator's bridge has reported a capability list,
  //      restrict bridge tools to the intersection of what the bridge
  //      advertises AND what TOOL_DEFINITIONS knows. Skipped on null
  //      (older bridge daemons / never-pinged pairings) — falls back
  //      to the hardcoded TOOL_DEFINITIONS bridge set.
  //
  //   3. toolPalette (Phase D — manifest per-agent allowlist)
  //      Operator's intent: "what's this agent allowed to call?"
  //      Undefined = no filter; empty array = chat-only.
  //
  //   4. Cloud tools (defer:false) are unaffected by 1+2 — they
  //      execute server-side on Vercel, not the bridge.
  let activeTools: ToolDef[] = TOOL_DEFINITIONS;
  if (args.excludeDeferredTools) {
    activeTools = activeTools.filter((t) => !t.defer);
  } else if (args.bridgeAdvertisedTools !== undefined && args.bridgeAdvertisedTools !== null) {
    const advertised = new Set(args.bridgeAdvertisedTools);
    activeTools = activeTools.filter((t) => !t.defer || advertised.has(t.name));
  }
  if (args.toolPalette !== undefined) {
    const allow = new Set(args.toolPalette);
    activeTools = activeTools.filter((t) => allow.has(t.name));
  }
  // Filter 5 (LAST — most-restrictive wins): plan mode. Strips every write
  // tool to the read/search allowlist. Plan mode also re-shapes the system
  // prompt with the overlay (see PLAN_MODE_PROMPT_OVERLAY), applied where
  // `system` is composed by streamAnthropicWithTools before this loop runs.
  if (args.chatMode === "plan") {
    activeTools = filterToolsForMode(activeTools, "plan");
  }
  let totalIn = args.startTotalIn;
  let totalOut = args.startTotalOut;

  for (let iter = args.startIter; iter < MAX_TOOL_ITERATIONS; iter++) {
    // Output tokens for THIS iteration only. Anthropic's message_delta
    // events report a cumulative count within a single message — not
    // per-event deltas — so we OVERWRITE on each frame and add the
    // final value into totalOut after the inner loop ends. Adding on
    // every event would double-count by a factor of (frames per message).
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 4096,
      stream: true,
      system,
      messages: history,
    };
    if (enableTools) {
      // Strip `defer` — it's our internal flag that tells the runner this
      // tool round-trips to the operator's local bridge instead of executing
      // server-side. Anthropic's tools[] schema only accepts name +
      // description + input_schema; any extra key triggers a 400 with
      // "tools.N.custom.<key>: Extra inputs are not permitted". Older code
      // passed activeTools through raw and silently broke API-key mode for
      // every chat where the palette included a deferred tool.
      body.tools = activeTools.map(({ name, description, input_schema }) => ({
        name,
        description,
        input_schema,
      }));
    }

    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const detail = await safeText(res);
      yield {
        type: "error",
        message:
          res.status >= 500 || res.status === 429
            ? `provider_temporarily_unavailable:anthropic_${res.status}`
            : `anthropic_${res.status}:${detail}`,
      };
      return;
    }

    // Accumulate content blocks from this streaming turn. Text blocks emit
    // deltas to the caller as they arrive; tool_use blocks are buffered
    // until message_stop so we can dispatch them all at once.
    const blocks: ContentBlock[] = [];
    const blockBuffers = new Map<number, { kind: "text" | "tool_use"; partial: string }>();
    let stopReason: string | null = null;
    let iterOut = 0;

    for await (const ev of parseSSE(res.body)) {
      // content_block_*, message_delta, etc.) — each branch reads
      const data = asSSERecord(ev.data);
      if (!data) continue;
      if (ev.event === "message_start") {
        const usage = asSSERecord(asSSERecord(data.message)?.usage);
        if (usage) totalIn += typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      } else if (ev.event === "content_block_start") {
        const block = asSSERecord(data.content_block);
        const idx = typeof data.index === "number" ? data.index : -1;
        if (idx < 0) continue;
        if (block?.type === "text") {
          blockBuffers.set(idx, { kind: "text", partial: "" });
          blocks[idx] = { type: "text", text: "" };
        } else if (block?.type === "tool_use") {
          blockBuffers.set(idx, { kind: "tool_use", partial: "" });
          blocks[idx] = {
            type: "tool_use",
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            input: {},
          };
        }
      } else if (ev.event === "content_block_delta") {
        const idx = typeof data.index === "number" ? data.index : -1;
        const buf = blockBuffers.get(idx);
        if (!buf) continue;
        const delta = asSSERecord(data.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          buf.partial += delta.text;
          const b = blocks[idx];
          if (b?.type === "text") b.text += delta.text;
          yield { type: "delta", text: delta.text };
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          buf.partial += delta.partial_json;
        }
      } else if (ev.event === "content_block_stop") {
        const idx = typeof data.index === "number" ? data.index : -1;
        const buf = blockBuffers.get(idx);
        if (!buf) continue;
        if (buf.kind === "tool_use") {
          // Finalize the tool_use input — parse the accumulated JSON
          const b = blocks[idx];
          if (b?.type === "tool_use") {
            try {
              b.input = buf.partial ? JSON.parse(buf.partial) : {};
            } catch {
              b.input = {};
            }
          }
        }
        blockBuffers.delete(idx);
      } else if (ev.event === "message_delta") {
        const delta = asSSERecord(data.delta);
        if (delta?.stop_reason) stopReason = String(delta.stop_reason);
        // Cumulative for THIS message — overwrite, don't add. Final
        // message_delta has the total; we add to totalOut after the loop.
        const usage = asSSERecord(data.usage);
        if (typeof usage?.output_tokens === "number") {
          iterOut = usage.output_tokens;
        }
      } else if (ev.event === "message_stop") {
        break;
      }
    }
    totalOut += iterOut;

    // If the model didn't ask to call any tools, we're done. Filter
    // tool_use blocks defensively: a block with no id or name would
    // get rejected on the next API call (Anthropic requires both), so
    // dropping it here gives a cleaner error than a 400 we'd have to
    // translate. In practice the API always emits both — this guards
    // against transient stream truncation, not normal traffic.
    const toolUses = blocks.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
        b?.type === "tool_use" && typeof b.id === "string" && b.id.length > 0 && typeof b.name === "string" && b.name.length > 0
    );
    if (toolUses.length === 0 || stopReason !== "tool_use") {
      yield { type: "done", inputTokens: totalIn, outputTokens: totalOut };
      return;
    }

    // Defense-in-depth: reject any tool_use whose name is NOT in the
    // activeTools set computed for this iteration. The model is only
    // *told* about activeTools in the API call, but stream replay, a
    // future provider adapter, or a malformed response could surface
    // a name we didn't advertise. Filtering at send is necessary but
    // not sufficient — we also gate at dispatch. (Codex adversarial
    // review 2026-05-22, Finding #6.)
    //
    // Blocked calls become error tool_result blocks injected into the
    // NEXT iteration's history so the model sees its mistake + can
    // pick a different approach. Allowed calls continue to the
    // deferred/executeTool dispatch below.
    const allowedToolNames = new Set(activeTools.map((t) => t.name));
    const blockedToolUses = toolUses.filter((tu) => !allowedToolNames.has(tu.name));
    const dispatchableToolUses = toolUses.filter((tu) => allowedToolNames.has(tu.name));
    const blockedResultBlocks: ContentBlock[] = blockedToolUses.map((tu) => ({
      type: "tool_result" as const,
      tool_use_id: tu.id,
      content: JSON.stringify({
        error: "tool_not_allowed_in_current_mode",
        tool: tu.name,
        hint: args.chatMode === "plan"
          ? `${tu.name} is unavailable in plan mode. Run /build to restore the full tool registry.`
          : `${tu.name} is not in the current agent's tool palette.`,
      }),
      is_error: true,
    }));
    for (const tu of blockedToolUses) {
      yield {
        type: "tool_result",
        name: tu.name,
        ok: false,
        summary: `${tu.name} blocked — not in active tool palette`,
      };
    }
    // If literally EVERY tool the model called was blocked, surface that
    // up to the loop as a user-turn tool_result and continue to the next
    // iteration so the model can recover. Don't run the deferred + execute
    // path because there's nothing dispatchable.
    if (dispatchableToolUses.length === 0 && blockedResultBlocks.length > 0) {
      history.push({ role: "user", content: blockedResultBlocks });
      continue;
    }

    // Append the assistant turn (text + tool_use blocks) to history.
    history.push({
      role: "assistant",
      content: blocks.filter(Boolean) as ContentBlock[],
    });

    // Phase 2 deferred-tool short-circuit: if ANY of the tool_use blocks
    // points at a tool marked defer:true, we can't keep iterating
    // server-side — the operator's local bridge has to execute the tool
    // and POST the result back via /api/chat/resume. Capture the in-
    // flight state and exit. (If a single turn mixes deferred + non-
    // deferred tools, we pause on the first deferred one and defer ALL
    // remaining tool calls to the resume; the model will re-emit them.
    // In practice the model issues one tool_use per turn unless we ask
    // for parallel-tools, which we don't.)
    const deferred = dispatchableToolUses.find((tu) => {
      const def = TOOL_DEFINITIONS.find((d) => d.name === tu.name);
      return def?.defer === true;
    });
    if (deferred) {
      yield {
        type: "tool_use_pending",
        tool_use_id: deferred.id,
        name: deferred.name,
        input: deferred.input,
        resume_state: {
          model,
          system,
          history,
          iteration: iter,
          totalIn,
          totalOut,
          maxTokens,
          enableTools,
          toolPalette: args.toolPalette,
          // Critical: persist chatMode across the pause so the tool
          // filter re-applies on resume. Without this, a plan-mode turn
          // that pauses for a deferred bridge tool would silently regain
          // the full tool registry on resume.
          chatMode: args.chatMode,
          // Persist the bridge-capability + defer filters too. Without
          // these, the post-resume iteration would re-derive
          // activeTools using `args.excludeDeferredTools` /
          // `args.bridgeAdvertisedTools` from a fresh-args path that
          // doesn't have them — broadening the tool palette mid-turn.
          // (Codex Finding #8.)
          excludeDeferredTools: args.excludeDeferredTools,
          bridgeAdvertisedTools: args.bridgeAdvertisedTools,
        },
      };
      return;
    }

    // Execute each dispatchable tool call, surface to the operator, and
    // queue the tool_result blocks for the next turn. Blocked-tool errors
    // (from the allowlist gate above) are prepended so the model sees
    // BOTH its blocked attempt AND any successful sibling calls in one
    // history turn.
    const resultBlocks: ContentBlock[] = [...blockedResultBlocks];
    for (const tu of dispatchableToolUses) {
      yield { type: "tool_use", name: tu.name, input: tu.input };
      const result = await executeTool(tu.name, tu.input, ctx);
      yield {
        type: "tool_result",
        name: tu.name,
        summary: result.summary,
        ok: !result.is_error,
      };
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.is_error,
      });
    }
    history.push({ role: "user", content: resultBlocks });
    // Loop — the next iteration re-opens the stream with the new history.
  }

  // Hit the iteration cap — tell the operator instead of looping forever.
  yield {
    type: "error",
    message: `tool_loop_exhausted_after_${MAX_TOOL_ITERATIONS}_iterations`,
  };
}

// ============================================================================
// Prompt block — teaches non-Anthropic providers about the tool surface so
// they can still emit text markers. For Anthropic, the tools are passed via
// the API contract and this block is unused.
// ============================================================================

export function cloudToolsPromptBlockV2(opts: { bridgeOnline?: boolean } = {}): string {
  const cloudTools = TOOL_DEFINITIONS.filter((t) => !t.defer);
  // Hide bridge tools from the persona block when the bridge is offline.
  // The Anthropic tools[] array sent on the API call is already filtered
  // by excludeDeferredTools in runIterationLoop; the persona block
  // following the same rule keeps the model from being told it has tools
  // it can't actually call this turn.
  const bridgeTools = opts.bridgeOnline === false
    ? []
    : TOOL_DEFINITIONS.filter((t) => t.defer);
  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("CLOUD TOOLS — REAL TOOL_USE");
  lines.push("");
  lines.push(
    "You're running in cloud mode with a real tool_use loop. The runtime exposes two tiers of tools — call them like any native Claude tool. All are tenant-scoped to the current operator and audit-logged."
  );
  lines.push("");
  lines.push("Cloud tools (always available, execute server-side on Vercel):");
  for (const t of cloudTools) {
    lines.push(`- ${t.name} — ${t.description}`);
  }
  if (bridgeTools.length > 0) {
    lines.push("");
    lines.push("Bridge tools (the operator's local bridge IS online — these execute on their machine via the dashboard's browser proxy):");
    for (const t of bridgeTools) {
      lines.push(`- ${t.name} — ${t.description}`);
    }
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("- Prefer get_record over list_records once you have an ID.");
  lines.push("- Confirm with the operator before delete_record (no undo).");
  lines.push("- Don't use http_get/http_post for the operator's own integrations — that needs a connector.");
  lines.push("- For bridge tools (read_file, write_file, bash, send_email, send_sms): if a tool returns is_error with 'bridge_unreachable' in the body, the operator's local bridge isn't running. Tell them to start it (pm2 restart claude-bridge) instead of retrying.");
  lines.push("- For send_email / send_sms: always confirm content with the operator before sending. Include opt-out language on first-touch SMS.");
  lines.push("- Tool results return JSON; quote relevant fields in your reply.");
  if (bridgeTools.length > 0) {
    lines.push("");
    lines.push("DISCOVERY POSTURE (CRITICAL):");
    lines.push("- The operator has a library of pre-built playbooks (`skills/`) and Python tools (`scripts/`). DO NOT improvise workflows when one already exists — your job is to execute their established SOPs, not reinvent them.");
    lines.push("- For procedural requests (briefings, recurring workflows, named tasks): call list_skills FIRST to find the playbook, then load_skill to read its steps, then follow them.");
    lines.push("- For 'do X with service Y' requests (Stripe, Supabase, n8n, Gmail, Twilio, Firecrawl): call list_scripts to see if there's a tool wrapper, then run_script with `--help` to see its commands, then run_script with the real args. Most documented tools support `--json` — use it so you get structured output.");
    lines.push("- Only fall back to raw bash when nothing in skills/ or scripts/ fits.");
  }
  return lines.join("\n");
}

// SSE parser + safeText are shared with lib/providers.ts — see lib/sse-parser.ts.
