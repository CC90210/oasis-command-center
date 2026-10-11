/**
 * lib/os/runs/computer-turn.ts - buildComputerTurn: everything the claim
 * route (app/api/bridge/runs/claim/route.ts) hands a person's own paired
 * computer to run ONE department turn itself, with the oasis MCP server as
 * its tools (O4 pull dispatch).
 *
 * Reuses prepareAgentTurn's 'computer' engineInput branch (lib/os/
 * department-agent.ts) for the department/agent binding and the system
 * prompt, and groundDepartmentTurn's new computer branch (lib/os/desk/
 * turn.ts) for the DEPARTMENT STATE block and the palette -- the SAME two
 * calls every other channel makes, so a department speaks as the SAME
 * department whichever engine answers it. Nothing here streams a model:
 * the computer runs Claude Code itself; this module only builds what it is
 * handed.
 *
 * CALLER'S RESPONSIBILITY (not re-checked here): liveSeat and
 * departmentGate on `viewer` must already have passed for this run's
 * (tenant, user) before buildComputerTurn is called -- the claim route does
 * this once, right after claiming, and finishes the run `seat_removed` if
 * it fails rather than calling this at all.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { prepareAgentTurn } from "@/lib/os/department-agent";
import { groundDepartmentTurn } from "@/lib/os/desk/turn";
import { composeComputerPrompt } from "@/lib/ai/bridge-turn";
import { deskToolset } from "@/lib/os/desk/tools";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";
import { mintMcpToken, type McpProfile } from "@/lib/mcp/bearer";
import { mintRunCredential, runSigningKey } from "./producer-auth";
import { historyFor, type Run, type RunScope } from "./store";
import type { OsViewer } from "@/components/os/department/viewer";
import type { OsDepartment } from "@/lib/os/departments";
import type { ChatMessage, StreamEvent } from "@/lib/providers";
import { fetchTenantVaultSecretsForRedaction } from "@/lib/chat-persistence";
import { redactAll, redactTenantVaultSecrets, type VaultSecret } from "@/lib/secret-redaction";

/** The run token outlives the 20-minute claim deadline a little, so a last event posted right at the edge still verifies. */
export const RUN_TOKEN_TTL_SEC = 1500;
/** The MCP bearer never outlives the run's own deadline, and never more than this. */
export const MCP_TOKEN_MAX_TTL_SEC = 1200;
/** The system prompt a connector gets, whole: capped so a very large department page summary never reaches an unbounded size. */
export const COMPUTER_SYSTEM_PROMPT_CHARS = 12_000;
export const COMPUTER_MAX_TURNS = 24;

const MCP_URL = "https://oasisai.work/api/mcp";
const EVENTS_URL_BASE = "https://oasisai.work/api/os/runs";

export type ClaimRunBody = {
  id: string;
  protocol: "department_task_v1";
  origin: Run["origin"];
  claim_id: string;
  cli: "claude";
  system: string;
  prompt: string;
  max_turns: number;
  deadline_at: string;
  events_url: string;
  run_token: string;
  allowed_tools: string[];
  department: {
    profile: McpProfile;
    mcp_url: string;
    token: string;
    exp: number;
    sid: string;
    history_hash: string;
    name: string;
  };
};

export type ComputerTurnResult = { ok: true; body: ClaimRunBody } | { ok: false; status: number; error: string };

export type BuildComputerTurnInput = {
  db: Client;
  /** The claimed run: status 'running', source 'producer', executor 'computer', deadline_at and lease_id set (claimComputerRun). */
  run: Run;
  /** Already liveSeat + departmentGate checked for this run's (tenant, user) by the caller. */
  viewer: OsViewer;
  tenantSlug: string;
  dept: OsDepartment;
  operatorName: string;
  email: string;
  /** The claiming computer's own label ("ANN-LAPTOP (Windows)"), for the system prompt's runsOn line. */
  label: string;
  /** run.claimedPairingId, carried explicitly so a caller never has to re-derive it from the row. */
  pairingId: string;
  /** The auth user's CURRENT session_version, for the MCP bearer's `sv` claim (lib/os/seat.ts liveSeat). */
  sessionVersion: number;
};

/** groundDepartmentTurn's plainStream is never invoked for a computer turn (its own 'isComputerEngine' branch returns before touching it); this stub exists only to satisfy the parameter and fails loud if that ever changes. */
async function* refusePlainStream(): AsyncGenerator<StreamEvent> {
  throw new Error("computer-turn: groundDepartmentTurn's plainStream must never be called for a computer-dispatched turn");
}

export async function buildComputerTurn(input: BuildComputerTurnInput): Promise<ComputerTurnResult> {
  const { db, run, viewer, tenantSlug, dept, operatorName, email, label, pairingId, sessionVersion } = input;

  const prepared = await prepareAgentTurn({
    tenantId: run.tenantId,
    tenantSlug,
    agentSlug: run.agentSlug,
    department: dept,
    operator: { name: operatorName, email },
    platformFallback: null,
    revealModel: false,
    userId: run.userId,
    chatMode: run.chatMode,
    engineInput: { kind: "computer", label },
  });
  if (!prepared.ok) return { ok: false, status: prepared.status, error: prepared.error };
  const t = prepared.turn;

  const desk = t.department
    ? await groundDepartmentTurn({
        turn: t,
        viewer,
        chatMode: run.chatMode,
        maxTokens: DEPARTMENT_REPLY_MAX_TOKENS,
        plainStream: (_turn: unknown, _messages: readonly ChatMessage[], _maxTokens: number): AsyncGenerator<StreamEvent> => refusePlainStream(),
      })
    : null;
  const systemFull: string = desk?.system ?? t.system;

  // A chat run carries its earlier turns, fenced (composeComputerPrompt);
  // O4 writes no other origin, but the shape is harmless either way (an
  // automation/test run would simply have an empty history). historyFor
  // returns a member's STORED message text unchanged -- if someone pasted a
  // credential into a chat, it reaches here verbatim. groundDepartmentTurn's
  // own scrub covers only the DEPARTMENT STATE block it appends to `system`,
  // never the base prompt or this prompt/history text.
  const history = await historyFor(db, { tenantId: run.tenantId, userId: run.userId } satisfies RunScope, run.conversationId, run.seq);

  // COMPLETE or nothing (the rule every other outbound-text boundary in this
  // codebase follows -- the events route, groundDepartmentTurn): an entry
  // that cannot be read or decrypted fails the whole claim rather than
  // sending the computer a system prompt and conversation scrubbed of only
  // SOME of this workspace's secrets. Covers the env-secret pattern
  // (redactAll, a pasted credential whose value matches a live secret) AND
  // this tenant's own vault values, over the COMPLETE outbound text -- the
  // base system prompt, the appended department-state block (already
  // scrubbed once by groundDepartmentTurn; redacting it again is harmless),
  // and every message in the conversation history.
  let vault: VaultSecret[];
  try {
    vault = await fetchTenantVaultSecretsForRedaction(run.tenantId, { requireComplete: true });
  } catch {
    return { ok: false, status: 503, error: "scrub_unavailable" };
  }
  const scrub = (text: string): string => redactTenantVaultSecrets(redactAll(text), vault);
  // Scrub BEFORE any cap or clip (security review, O4): exact-value redaction
  // cannot recognise a secret that a truncation cut in half, so cutting first
  // would leak the part of a secret that straddles the cut.
  const systemScrubbed = scrub(systemFull);
  const system =
    systemScrubbed.length > COMPUTER_SYSTEM_PROMPT_CHARS
      ? `${systemScrubbed.slice(0, COMPUTER_SYSTEM_PROMPT_CHARS)}\n…[truncated]`
      : systemScrubbed;
  const prompt = scrub(
    composeComputerPrompt(
      history.map((m) => ({ role: m.role, content: scrub(String(m.content ?? "")) })),
      scrub(run.userText),
    ),
  );

  const planMode = run.chatMode === "plan";
  const toolset = deskToolset({ viewer, dept, agentSlug: run.agentSlug, planMode });
  const allowedTools = toolset.palette.map((p) => p.name);

  const deadlineMs = run.deadlineAt ? Date.parse(run.deadlineAt) : NaN;
  const nowMs = Date.now();
  const mcpTtlSeconds = Number.isFinite(deadlineMs) ? Math.max(1, Math.min(Math.floor((deadlineMs - nowMs) / 1000), MCP_TOKEN_MAX_TTL_SEC)) : MCP_TOKEN_MAX_TTL_SEC;
  const prof: McpProfile = planMode ? "read" : "propose";

  let mcp: { token: string; exp: number };
  try {
    mcp = await mintMcpToken({
      tid: run.tenantId,
      uid: run.userId,
      dept: dept.key,
      prof,
      sid: run.conversationId,
      rid: run.id,
      pid: pairingId,
      sv: sessionVersion,
      orig: run.origin,
      ttlSeconds: mcpTtlSeconds,
    });
  } catch {
    return { ok: false, status: 503, error: "oasis_mcp_not_configured" };
  }

  const signingKey = await runSigningKey();
  if (!signingKey) return { ok: false, status: 503, error: "producer_not_configured" };
  const runToken = await mintRunCredential(signingKey, { runId: run.id, tenantId: run.tenantId, ttlSec: RUN_TOKEN_TTL_SEC });

  const body: ClaimRunBody = {
    id: run.id,
    protocol: "department_task_v1",
    origin: run.origin,
    claim_id: run.leaseId ?? "",
    cli: "claude",
    system,
    prompt,
    max_turns: COMPUTER_MAX_TURNS,
    deadline_at: run.deadlineAt ?? new Date(nowMs).toISOString(),
    events_url: `${EVENTS_URL_BASE}/${run.id}/events`,
    run_token: runToken,
    allowed_tools: allowedTools,
    department: {
      profile: prof,
      mcp_url: MCP_URL,
      token: mcp.token,
      exp: mcp.exp,
      sid: run.conversationId,
      history_hash: "",
      name: dept.key,
    },
  };
  return { ok: true, body };
}
