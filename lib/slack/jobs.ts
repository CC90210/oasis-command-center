/**
 * lib/slack/jobs.ts - an @mention in Slack becomes ONE approval with the
 * department's draft reply, and a card in the thread that asks for it.
 *
 * WHY A JOB. Slack wants an answer within 3 seconds; a model turn can take
 * longer. The events route (lib/slack/events.ts) records the mention and hands
 * this job to dispatchSlackMentionJob:
 *   - a Cloudflare Queue when the Worker has the SLACK_AGENT_JOBS binding
 *     (consumers get 15 minutes; worker-entry.ts feeds each message back to
 *     /api/webhooks/slack/jobs, signed);
 *   - otherwise after the response (next/server after(), the Worker's
 *     waitUntil, about 30 seconds): the reply is capped at 1,024 tokens so a
 *     turn fits.
 *
 * WHAT THE JOB DOES, IN ORDER
 *   1. The Slack team must still route to the job's workspace.
 *   2. The department: named in the text, else the channel's, else the
 *      workspace's default (Chief of Staff; in a client workspace without a
 *      Chief of Staff teammate, the first department that has one:
 *      lib/slack/routing.ts). It must have an agent in this workspace
 *      (components/os/department/config.ts), or a one-line notice says it is
 *      not set up.
 *   3. Exactly once per Slack event: an approval with this event's key already
 *      existing means a retry, and nothing runs again (no second model call).
 *   4. The turn (lib/os/department-agent.ts, metered, budget-checked, the same
 *      rules as the web channel). The matching workspace AI account pays;
 *      Slack never substitutes the OASIS platform key.
 *   5. The draft becomes a send_slack_message approval (Feed shows it). Under
 *      the mention goes a line with NO draft text ("drafted a reply for review
 *      in OASIS"); the draft and its Approve button go ephemerally to the
 *      person who asked, only when they are an active owner or admin linked by
 *      email (lib/slack/send.ts postApprovalRequest). Nothing the agent wrote
 *      is readable by the channel until someone approves it and it is posted.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { resolveWebhookRoute } from "@/lib/connections/store";
import { appOrigin } from "@/lib/connections/popup";
import { getTenant } from "@/lib/queries";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { adminGetUser } from "@/lib/turso-auth-admin";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { getWorkspaceManifest } from "@/lib/manifest/loader";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";
import { departmentChannelFor } from "@/components/os/department/config";
import { failureCopy, isTurnFailureCode, type TurnFailureCode } from "@/lib/os/channel/outcome";
import { recordTurnOutcome } from "@/lib/os/channel/turns";
import { prepareAgentTurn, runAgentTurnToText } from "@/lib/os/department-agent";
import { workspaceApiFallbackReplyLabel, type AgentEngineChoice } from "@/lib/ai/agent-engine";
import { readEffectiveAgentEngine } from "@/lib/ai/agent-engine-store";
import { createApproval, parsePayload } from "@/lib/os/approvals/store";
import type { SlackFetch } from "@/lib/slack/client";
import {
  defaultMentionDepartment,
  departmentForMention,
  departmentLabelOf,
  isDepartmentKey,
  isSlackChannelId,
  isSlackTeamId,
  isSlackTs,
} from "@/lib/slack/routing";
import { slackApproverProfile } from "@/lib/slack/identity";
import { postApprovalRequest, postNotice } from "@/lib/slack/send";
import { liveSeat } from "@/lib/os/seat";
import { RunsUnavailableError } from "@/lib/os/runs/store";

/** A reply short enough to be a Slack message, and a turn short enough for waitUntil. */
export const SLACK_REPLY_MAX_TOKENS = 1024;

export type SlackMentionJob = {
  v: 1;
  kind: "mention";
  tenantId: string;
  teamId: string;
  channelId: string;
  channelName: string | null;
  /** The thread the reply goes in: the mention's thread_ts, or its own ts. */
  threadTs: string;
  eventId: string;
  slackUserId: string;
  /** The teammate the Slack user is linked to in this workspace (lib/slack/identity.ts), if any. */
  profileId: string | null;
  authorName: string | null;
  text: string;
  channelDepartment: DepartmentKey | null;
  customerId: string | null;
};

export function isSlackMentionJob(v: unknown): v is SlackMentionJob {
  if (!v || typeof v !== "object") return false;
  const j = v as Record<string, unknown>;
  return (
    j.v === 1 &&
    j.kind === "mention" &&
    typeof j.tenantId === "string" &&
    j.tenantId.length > 0 &&
    isSlackTeamId(j.teamId) &&
    isSlackChannelId(j.channelId) &&
    isSlackTs(j.threadTs) &&
    typeof j.eventId === "string" &&
    /^[A-Za-z0-9]{4,64}$/.test(j.eventId) &&
    typeof j.slackUserId === "string" &&
    (j.profileId === null || typeof j.profileId === "string") &&
    typeof j.text === "string" &&
    (j.channelDepartment === null || isDepartmentKey(j.channelDepartment)) &&
    (j.customerId === null || typeof j.customerId === "string")
  );
}

export type JobOutcome =
  | { outcome: "approval_created"; approvalId: string; noticePosted: boolean; reviewSent: boolean }
  | { outcome: "duplicate"; approvalId: string }
  | { outcome: "notice"; reason: string; noticePosted: boolean }
  | { outcome: "dropped"; reason: string };

export type SlackJobDeps = {
  db: Client;
  now: () => Date;
  fetchImpl?: SlackFetch;
  /** Test seams; production uses the real turn. */
  prepare?: typeof prepareAgentTurn;
  runText?: typeof runAgentTurnToText;
  readEngine?: typeof readEffectiveAgentEngine;
  runDevice?: typeof runSlackDeviceTurn;
};

export function approvalKeyForEvent(eventId: string): string {
  return `slack:${eventId}`;
}

async function existingApproval(db: Client, tenantId: string, key: string): Promise<string | null> {
  const rs = await db.execute({
    sql: "SELECT id FROM approvals WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1",
    args: [tenantId, key],
  });
  return rs.rows[0] ? String((rs.rows[0] as unknown as Record<string, unknown>).id) : null;
}

async function notice(deps: SlackJobDeps, job: SlackMentionJob, reason: string, text: string): Promise<JobOutcome> {
  const posted = await postNotice(
    deps.db,
    { tenantId: job.tenantId, teamId: job.teamId, channelId: job.channelId, threadTs: job.threadTs, text },
    { fetchImpl: deps.fetchImpl },
  );
  if (!posted.ok) console.error("[slack.jobs] notice not posted", { tenantId: job.tenantId, reason, error: posted.reason });
  return { outcome: "notice", reason, noticePosted: posted.ok };
}

async function recordTurn(deps: SlackJobDeps, tenantId: string, department: DepartmentKey, agentSlug: string, code: TurnFailureCode | null) {
  try {
    await recordTurnOutcome(deps.db, {
      tenantId,
      channelKey: `dept:${department}`,
      agentSlug,
      ok: code === null,
      code,
      at: deps.now().toISOString(),
    });
  } catch (err) {
    console.error("[slack.jobs.record_turn]", { tenantId, department, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The words the model is given: the question, and where it came from. No instructions from the message are obeyed as ours. */
export function mentionPrompt(job: SlackMentionJob, question: string): string {
  const where = job.channelName ? `#${job.channelName}` : "a Slack channel";
  const who = job.authorName ? job.authorName : "a teammate";
  return [
    `[A message from ${who} in ${where}, sent to you in Slack. Draft the reply that will be posted in the thread.`,
    "Keep it short, like a Slack message. A person approves the reply before it is posted, so do not say you have already done or sent anything.",
    "If you do not have the facts to answer, say what you would need instead of guessing.]",
    "",
    question,
  ].join("\n");
}

type LinkedSlackActor = { userId: string; email: string | null };

async function linkedSlackActor(db: Client, tenantId: string, profileId: string | null): Promise<LinkedSlackActor | null> {
  if (!profileId) return null;
  const rs = await db.execute({
    sql: "SELECT auth_user_id FROM user_profiles WHERE id = ? AND tenant_id = ? AND deactivated_at IS NULL LIMIT 1",
    args: [profileId, tenantId],
  });
  const r = rs.rows[0] as unknown as { auth_user_id: string | null } | undefined;
  if (!r?.auth_user_id) return null;
  try {
    const auth = await adminGetUser(getServiceSupabase(), String(r.auth_user_id));
    if (!auth.ok) {
      console.error("[slack.jobs] the teammate's auth record could not be read", { tenantId, error: auth.error });
      return null;
    }
    return { userId: String(r.auth_user_id), email: auth.value.email };
  } catch (err) {
    console.error("[slack.jobs] the teammate's auth record could not be read", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type SlackDeviceTurnResult =
  | { ok: true; text: string; fellBackFrom: string | null }
  | { ok: false; status: number; error: string };

function stableUuid(namespace: string, tenantId: string, userId: string, eventId: string): string {
  const hex = createHash("sha256")
    .update(`oasis:slack:${namespace}:${tenantId}:${userId}:${eventId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  // UUID v5-shaped IDs keep the run-store's trusted-id contract while the
  // SHA-256 input (not browser input) provides the durable retry identity.
  hex[12] = "5";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function slackDeviceRunIdentity(tenantId: string, userId: string, eventId: string): {
  conversationId: string;
  runId: string;
} {
  return {
    conversationId: stableUuid("conversation", tenantId, userId, eventId),
    runId: stableUuid("run", tenantId, userId, eventId),
  };
}

function sseFrames(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    let event = "message";
    let data = "";
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return [];
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [{ event, data: parsed as Record<string, unknown> }]
        : [];
    } catch {
      return [];
    }
  });
}

/** Run one Slack draft through the exact-pairing department_task_v2 lane and
 * wait for its durable run result. The requester is the linked workspace seat;
 * an unlinked Slack identity cannot borrow the agents owner's permissions. */
export async function runSlackDeviceTurn(input: {
  deps: SlackJobDeps;
  job: SlackMentionJob;
  dept: OsDepartment;
  tenantSlug: string;
  agentSlug: string;
  prompt: string;
  expectedEngine: Exclude<AgentEngineChoice, { kind: "api" }>;
}): Promise<SlackDeviceTurnResult> {
  const { deps, job, dept, agentSlug, prompt, expectedEngine } = input;
  const actor = await linkedSlackActor(deps.db, job.tenantId, job.profileId);
  if (!actor) return { ok: false, status: 409, error: "slack_identity_not_linked" };
  // Keep the heavy department-run/viewer stack off ordinary API-mode Slack
  // jobs (and their Worker cold start). It is needed only for a saved device
  // engine, after the canonical route decision and linked-identity check above.
  const [viewerModule, sessionModule, starterModule, sendModule] = await Promise.all([
    import("@/components/os/department/viewer"),
    import("@/lib/os/runs/session"),
    import("@/lib/os/runs/turn-starter"),
    import("@/lib/os/runs/send"),
  ]);
  const { resolveOsViewerFor } = viewerModule;
  const { resolveRunSession, sessionForQueuedFallback } = sessionModule;
  const { executorDepsFor } = starterModule;
  const { sendMessage } = sendModule;
  const seat = await liveSeat(job.tenantId, actor.userId);
  if (!seat.live) {
    return {
      ok: false,
      status: seat.reason === "unavailable" ? 503 : 403,
      error: seat.reason === "unavailable" ? "profile_unavailable" : "seat_inactive",
    };
  }
  const viewer = await resolveOsViewerFor(job.tenantId, actor.userId);
  if (!viewer.ok) {
    return { ok: false, status: viewer.reason === "degraded" ? 503 : 403, error: viewer.reason === "degraded" ? "profile_unavailable" : "seat_inactive" };
  }
  const resolved = await resolveRunSession({
    department: dept.key,
    actor: {
      tenantId: job.tenantId,
      user: { id: actor.userId, email: actor.email },
      profile: {
        team_role: seat.profile.teamRole,
        is_owner: seat.profile.isOwner,
        admin_access: seat.profile.adminAccess,
        display_name: job.authorName,
        full_name: job.authorName,
      },
      viewer,
      // Slack mentions are workspace-channel work. They use the workspace
      // default and therefore the approved agents-owner computer, not a
      // personal override from whichever member happened to mention it.
      engineUserId: null,
      operatorName: job.authorName ?? undefined,
    },
  });
  if (!resolved.ok) return resolved;

  try {
    const session = resolved.session;
    const dispatch = session.computerDispatch;
    const expectedKind = expectedEngine.kind === "cli" ? "cli" : "local";
    const expectedName = expectedEngine.kind === "cli" ? expectedEngine.cli : expectedEngine.model;
    if (
      !dispatch ||
      dispatch.pairingId !== expectedEngine.pairingId ||
      dispatch.engineKind !== expectedKind ||
      dispatch.engineName !== expectedName ||
      dispatch.fallback !== (expectedEngine.fallback ?? "none")
    ) {
      return { ok: false, status: 409, error: "engine_dispatch_unavailable" };
    }
    const idempotency = slackDeviceRunIdentity(job.tenantId, actor.userId, job.eventId);
    const response = await sendMessage({
      db: deps.db,
      deps: executorDepsFor(session, deps.db),
      showThinking: false,
      input: {
        department: dept.key,
        agentSlug,
        text: prompt,
        conversationId: "",
        chatMode: "build",
      },
      computerDispatch: session.computerDispatch,
      apiAccountSnapshot: session.apiAccountSnapshot,
      fallbackFrom: session.fallbackFrom,
      fallbackReason: session.fallbackReason,
      computerFallbackDeps: (reason) => {
        const fallbackSession = sessionForQueuedFallback(session, reason);
        return fallbackSession ? executorDepsFor(fallbackSession, deps.db) : null;
      },
      // A queue retry after the webhook's request window follows this exact
      // persisted run. It can never enqueue a second inference for one Slack
      // event, even while the selected computer is still working.
      idempotency,
    });
    const raw = await response.text();
    if (!response.ok) {
      try {
        const body = JSON.parse(raw) as { error?: unknown };
        return { ok: false, status: response.status, error: typeof body.error === "string" ? body.error : `http_${response.status}` };
      } catch {
        return { ok: false, status: response.status, error: `http_${response.status}` };
      }
    }
    let finalText = "";
    let errorCode: string | null = null;
    let fellBackFrom: string | null = null;
    for (const frame of sseFrames(raw)) {
      if (frame.event === "ev") {
        const kind = typeof frame.data.kind === "string" ? frame.data.kind : "";
        const data = frame.data.data && typeof frame.data.data === "object" && !Array.isArray(frame.data.data)
          ? frame.data.data as Record<string, unknown>
          : {};
        if (kind === "agent" && typeof data.fell_back_from === "string") fellBackFrom = data.fell_back_from;
        if (kind === "delta" && typeof data.text === "string") finalText += data.text;
        if (kind === "error" && typeof data.code === "string") errorCode = data.code;
      } else if (frame.event === "end") {
        if (typeof frame.data.final_text === "string" && frame.data.final_text.trim()) finalText = frame.data.final_text;
        if (typeof frame.data.error_code === "string" && frame.data.error_code) errorCode = frame.data.error_code;
      }
    }
    if (errorCode) return { ok: false, status: 409, error: errorCode };
    if (!finalText.trim()) return { ok: false, status: 502, error: "reply_empty" };
    return { ok: true, text: finalText.trim(), fellBackFrom };
  } catch (err) {
    if (err instanceof RunsUnavailableError) return { ok: false, status: 503, error: "chat_history_unavailable" };
    console.error("[slack.jobs.device-run]", {
      tenantId: job.tenantId,
      department: dept.key,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return { ok: false, status: 500, error: "send_failed" };
  }
}

export async function runSlackMentionJob(job: SlackMentionJob, deps: SlackJobDeps): Promise<JobOutcome> {
  const db = deps.db;
  const route = await resolveWebhookRoute(db, "slack", job.teamId);
  if (!route || route.tenantId !== job.tenantId) return { outcome: "dropped", reason: "team_not_routed_here" };

  const tenant = await getTenant(job.tenantId);
  if (!tenant?.slug) throw new Error("slack.jobs: the workspace could not be read");
  const oasis = isOasisSurfaceTenant(tenant.slug);
  // Who leads each department: the workspace's manifest, read the way the web
  // channel reads it (config.ts departmentChannelFor). A read that fails
  // THROWS, so the job is retried: a database that did not answer is never
  // posted into the client's Slack as "<Department> is not set up" (W4a
  // review R3). The slug too: resolveOwnedSlug answers a read that failed
  // with null, so no slug is a retry, never an empty roster (W4a D1).
  const tenantSlug = ((await resolveOwnedSlug(job.tenantId)) || "").toLowerCase();
  if (!tenantSlug) throw new Error("slack.jobs: the workspace has no manifest slug");
  const scope = { oasis, manifest: await getWorkspaceManifest(job.tenantId, tenantSlug) };

  const picked = departmentForMention({ text: job.text, channelDepartment: job.channelDepartment, defaultDepartment: defaultMentionDepartment(scope) });
  const dept = OS_DEPARTMENTS.find((d) => d.key === picked.department);
  if (!dept) return { outcome: "dropped", reason: "unknown_department" };
  const label = departmentLabelOf(dept.key);

  const key = approvalKeyForEvent(job.eventId);
  const prior = await existingApproval(db, job.tenantId, key);
  if (prior) return { outcome: "duplicate", approvalId: prior };

  if (!picked.question.trim()) {
    return notice(deps, job, "empty_question", `Ask ${label} a question after the mention, in the same message.`);
  }

  const binding = departmentChannelFor(dept.key, scope);
  if (binding.kind !== "agent") {
    return notice(deps, job, "department_not_set_up", `${label} is not set up in this workspace yet, so it cannot draft a reply.`);
  }

  const prompt = mentionPrompt(job, picked.question);
  let draftedText: string;
  let fallbackLabel = "";
  let canonical: Awaited<ReturnType<typeof readEffectiveAgentEngine>>;
  try {
    canonical = await (deps.readEngine ?? readEffectiveAgentEngine)(job.tenantId, null);
  } catch (err) {
    console.error("[slack.jobs] engine could not be read", {
      tenantId: job.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (canonical.engine.kind !== "api") {
    // Subscription/local work enters the same exact-pairing durable queue as
    // the department UI. Only that queue may promote the frozen run to the
    // workspace API account, and only when fallback_policy says so.
    const device = await (deps.runDevice ?? runSlackDeviceTurn)({
      deps,
      job,
      dept,
      tenantSlug,
      agentSlug: binding.agentSlug,
      prompt,
      expectedEngine: canonical.engine,
    });
    if (!device.ok) {
      if (isTurnFailureCode(device.error)) await recordTurn(deps, job.tenantId, dept.key, binding.agentSlug, device.error);
      const sentence = device.error === "slack_identity_not_linked"
        ? "link this Slack account to an active workspace member before using the selected computer. No API credits were used."
        : failureCopy(device.error, { canManageAi: false }).sentence;
      console.error("[slack.jobs] device turn refused", { tenantId: job.tenantId, department: dept.key, code: device.error });
      return notice(deps, job, device.error, `${label} could not draft a reply: ${sentence}`);
    }
    draftedText = device.text;
    fallbackLabel = device.fellBackFrom && !device.text.startsWith("Workspace API fallback")
      ? workspaceApiFallbackReplyLabel(device.fellBackFrom)
      : "";
    await recordTurn(deps, job.tenantId, dept.key, binding.agentSlug, null);
  } else {
    const prepare = deps.prepare ?? prepareAgentTurn;
    const prepared = await prepare({
      tenantId: job.tenantId,
      tenantSlug,
      agentSlug: binding.agentSlug,
      department: dept,
      operator: { name: job.authorName ?? "your team", email: "" },
      // Canonical API mode is exactly the saved workspace provider account.
      // A missing account fails closed; Slack never spends platform credits.
      platformFallback: null,
      revealModel: false,
      userId: null,
      jobId: key,
      engineChoice: canonical.engine,
      // The canonical read above chose the API branch. If settings change to
      // a device before preparation re-reads them, fail closed instead of
      // turning that race into unapproved workspace API spend.
      failClosedWithoutComputerDispatch: true,
    });
    if (!prepared.ok) {
      if (prepared.recordAs) await recordTurn(deps, job.tenantId, dept.key, binding.agentSlug, prepared.recordAs);
      const sentence =
        typeof prepared.extra?.hint === "string"
          ? prepared.extra.hint
          : prepared.error === "agent_not_configured"
            ? "this workspace has no AI account connected (Settings > AI brain)."
            : failureCopy(prepared.error, { canManageAi: false }).sentence;
      console.error("[slack.jobs] turn refused", { tenantId: job.tenantId, department: dept.key, code: prepared.error });
      return notice(deps, job, prepared.error, `${label} could not draft a reply: ${sentence}`);
    }

    const runText = deps.runText ?? runAgentTurnToText;
    const drafted = await runText(prepared.turn, [{ role: "user", content: prompt }], SLACK_REPLY_MAX_TOKENS);
    if (!drafted.ok) {
      await recordTurn(deps, job.tenantId, dept.key, binding.agentSlug, drafted.code);
      console.error("[slack.jobs] turn failed", { tenantId: job.tenantId, department: dept.key, code: drafted.code });
      return notice(deps, job, drafted.code, `${label} could not draft a reply: ${failureCopy(drafted.code, { canManageAi: false }).sentence}`);
    }
    draftedText = drafted.text;
    fallbackLabel =
      prepared.turn.engine?.kind === "api" && prepared.turn.engine.fellBackFrom
        ? workspaceApiFallbackReplyLabel(prepared.turn.engine.fellBackFrom)
        : "";
    await recordTurn(deps, job.tenantId, dept.key, binding.agentSlug, null);
  }

  const created = await createApproval(
    db,
    {
      tenantId: job.tenantId,
      departmentKey: dept.key,
      requestedBy: { type: "agent", id: binding.agentSlug },
      actionKind: "send_slack_message",
      title: `Slack reply in ${job.channelName ? `#${job.channelName}` : "a Slack thread"}`,
      targetRef: job.customerId ? `customer:${job.customerId}` : `slack:${job.teamId}:${job.channelId}`,
      payload: {
        team_id: job.teamId,
        channel_id: job.channelId,
        thread_ts: job.threadTs,
        text: `${fallbackLabel}${draftedText}`.slice(0, 4000),
        ...(job.channelName ? { channel_name: job.channelName } : {}),
        department: dept.key,
      },
      idempotencyKey: key,
    },
    deps.now(),
  );
  if (!created.ok) {
    console.error("[slack.jobs] approval not created", { tenantId: job.tenantId, error: created.error });
    throw new Error(`slack.jobs: the approval could not be created (${created.error})`);
  }
  if (!created.created) return { outcome: "duplicate", approvalId: created.approval.id };

  let openUrl: string | null = null;
  try {
    openUrl = `${appOrigin()}/feed?tab=needs`;
  } catch (err) {
    console.error("[slack.jobs] PUBLIC_APP_URL is not set; the card has no link", err instanceof Error ? err.message : err);
  }
  // The draft is shown in Slack only to the person who asked, and only when
  // they may approve it there (an active owner or admin, linked by email).
  // Everyone else in the channel sees a line with no draft in it.
  const approver = await slackApproverProfile(db, job.tenantId, job.profileId);
  const posted = await postApprovalRequest(
    db,
    {
      tenantId: job.tenantId,
      teamId: job.teamId,
      channelId: job.channelId,
      threadTs: job.threadTs,
      department: dept.key,
      // The card shows the words the approval binds to, as stored.
      draft: String(parsePayload(created.approval).text ?? ""),
      approvalId: created.approval.id,
      payloadHash: created.approval.payload_hash,
      openUrl,
      reviewer: approver ? job.slackUserId : null,
    },
    { fetchImpl: deps.fetchImpl },
  );
  if (!posted.notice.ok) console.error("[slack.jobs] review notice not posted (the approval is in Feed)", { tenantId: job.tenantId, reason: posted.notice.reason });
  if (approver && !posted.review.ok) console.error("[slack.jobs] review card not sent (the approval is in Feed)", { tenantId: job.tenantId, reason: posted.review.reason });
  return {
    outcome: "approval_created",
    approvalId: created.approval.id,
    noticePosted: posted.notice.ok,
    reviewSent: posted.review.ok,
  };
}

// -- Dispatch -------------------------------------------------------------------

export type SlackJobQueue = { send: (body: SlackMentionJob) => Promise<unknown> };

export type DispatchDeps = {
  /** The Worker's SLACK_AGENT_JOBS queue binding, when the deployment has one. */
  queue: SlackJobQueue | null;
  /** Run after the response (next/server after / waitUntil). */
  runLater: (task: () => Promise<void>) => void;
  run: (job: SlackMentionJob) => Promise<JobOutcome>;
};

/**
 * Hand a mention to the queue, or run it after the response. A queue send that
 * fails throws (the events route answers 500 and Slack retries); a job that
 * fails after the response is logged with its event id.
 */
export async function dispatchSlackMentionJob(job: SlackMentionJob, deps: DispatchDeps): Promise<"queued" | "after_response"> {
  if (deps.queue) {
    await deps.queue.send(job);
    return "queued";
  }
  deps.runLater(async () => {
    try {
      const out = await deps.run(job);
      console.log("[slack.jobs] mention handled", { tenantId: job.tenantId, eventId: job.eventId, outcome: out.outcome });
    } catch (err) {
      console.error("[slack.jobs] mention job failed", { tenantId: job.tenantId, eventId: job.eventId, error: err instanceof Error ? err.stack : String(err) });
    }
  });
  return "after_response";
}

let noContextLogged = false;

/** The SLACK_AGENT_JOBS queue binding, when this Worker has one; null elsewhere (and in tests). */
export async function slackJobQueueBinding(): Promise<SlackJobQueue | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const ctx = mod.getCloudflareContext();
    const q = (ctx.env as unknown as Record<string, unknown>).SLACK_AGENT_JOBS as SlackJobQueue | undefined;
    return q && typeof q.send === "function" ? q : null;
  } catch (err) {
    // Not running inside the Worker (a local server, a test): there is no queue
    // to find, and mentions run after the response. Said once per process.
    if (!noContextLogged) {
      noContextLogged = true;
      console.warn("[slack.jobs] no Cloudflare context; Slack mentions run after the response", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}
