/**
 * lib/slack/interactivity.ts - the "Approve and post" button on an approval
 * card in Slack.
 *
 * WHO MAY PRESS IT. The Slack user must be a full member of the connected team
 * (no guest, no other company) whose verified email is an ACTIVE owner or admin
 * of the same OASIS workspace (lib/slack/identity.ts links them). Anyone else
 * is told to decide in OASIS, and nothing is decided.
 *
 * WHAT A PRESS DOES. decideApproval(via "slack") with the payload hash the
 * button carries: the yes binds to the exact draft the card showed, and the
 * compare-and-swap makes it once (a second press, or a press after someone
 * approved in the Feed, gets "already decided"). Then executeApproval posts the
 * reply exactly once (its claim), and the card is replaced with the outcome.
 * An approved row whose execution never started (the request died) is carried
 * out by a press with the same hash, as the web approve route does.
 *
 * Send-back needs a note, which a button cannot carry: that stays in OASIS.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { resolveWebhookRoute } from "@/lib/connections/store";
import { resolvePersona, SURFACE_CAPABILITIES } from "@/lib/role-surfaces";
import { approvalScopeFor, DEPARTMENT_KEYS } from "@/lib/os/approvals/rules";
import { decideApproval, getApproval } from "@/lib/os/approvals/store";
import { executeApproval } from "@/lib/os/approvals/execute";
import type { ExecutorDeps } from "@/lib/os/approvals/executors";
import { respondToAction, type SlackFetch } from "@/lib/slack/client";
import { verifySlackRequest } from "@/lib/slack/verify";
import { resolveSlackIdentity } from "@/lib/slack/identity";
import { APPROVE_ACTION_ID, parseApproveButtonValue, slackTokenFor } from "@/lib/slack/send";
import { isSlackTeamId, isSlackUserId } from "@/lib/slack/routing";

type Env = Readonly<Record<string, string | undefined>>;

export type InteractivityDeps = {
  db: Client;
  now: () => Date;
  env?: Env;
  fetchImpl?: SlackFetch;
  executorDeps?: ExecutorDeps;
};

export type InteractivityResult = { status: number; body: Record<string, unknown>; replaced?: string };

type Profile = { auth_user_id: string; email: string | null; team_role: string | null; is_owner: number; deactivated_at: string | null };

async function profileInTenant(db: Client, tenantId: string, profileId: string): Promise<Profile | null> {
  const rs = await db.execute({
    sql: `SELECT auth_user_id, email, team_role, is_owner, deactivated_at FROM user_profiles WHERE id = ? AND tenant_id = ? LIMIT 1`,
    args: [profileId, tenantId],
  });
  const r = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!r || !r.auth_user_id) return null;
  return {
    auth_user_id: String(r.auth_user_id),
    email: r.email ? String(r.email) : null,
    team_role: r.team_role ? String(r.team_role) : null,
    is_owner: Number(r.is_owner) || 0,
    deactivated_at: r.deactivated_at ? String(r.deactivated_at) : null,
  };
}

const DECIDE_COPY: Record<string, string> = {
  not_found: "That approval is not in this workspace any more.",
  not_pending: "Someone already decided this approval. Nothing was posted twice.",
  expired: "This approval expired before anyone decided it. Ask again in the thread.",
  payload_mismatch: "This draft changed after the card was posted. Open it in OASIS to see the current version.",
  forbidden: "You can see this approval but you cannot decide it.",
};

export async function handleSlackInteractivity(
  input: { rawBody: string; timestamp: string | null; signature: string | null },
  deps: InteractivityDeps,
): Promise<InteractivityResult> {
  const now = deps.now();
  const verified = verifySlackRequest({ rawBody: input.rawBody, timestamp: input.timestamp, signature: input.signature, nowMs: now.getTime(), env: deps.env });
  if (!verified.ok) {
    if (verified.reason === "not_configured") return { status: 503, body: { ok: false, error: "slack_not_configured" } };
    return { status: 401, body: { ok: false, error: verified.reason } };
  }
  let payload: Record<string, unknown>;
  try {
    const raw = new URLSearchParams(input.rawBody).get("payload");
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return { status: 400, body: { ok: false, error: "payload_invalid" } };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: "payload_invalid" } };
  }
  if (payload.type !== "block_actions") return { status: 200, body: { ok: true, ignored: "not_a_button" } };
  const actions = Array.isArray(payload.actions) ? (payload.actions as Array<Record<string, unknown>>) : [];
  const action = actions.find((a) => a && a.action_id === APPROVE_ACTION_ID);
  if (!action) return { status: 200, body: { ok: true, ignored: "other_action" } };
  const button = parseApproveButtonValue(action.value);
  const team = (payload.team && typeof payload.team === "object" ? payload.team : {}) as Record<string, unknown>;
  const user = (payload.user && typeof payload.user === "object" ? payload.user : {}) as Record<string, unknown>;
  const responseUrl = typeof payload.response_url === "string" ? payload.response_url : null;
  if (!button || !isSlackTeamId(team.id) || !isSlackUserId(user.id)) return { status: 200, body: { ok: true, ignored: "malformed" } };

  const reply = async (text: string, replace: boolean): Promise<InteractivityResult> => {
    if (responseUrl) {
      const r = await respondToAction(
        responseUrl,
        replace ? { replace_original: true, text } : { response_type: "ephemeral", replace_original: false, text },
        { fetchImpl: deps.fetchImpl },
      );
      if (!r.ok) console.error("[slack.interactivity] could not update the card", { error: r.error });
    }
    return { status: 200, body: { ok: true }, replaced: text };
  };

  const routed = await resolveWebhookRoute(deps.db, "slack", team.id);
  if (!routed) return { status: 200, body: { ok: true, ignored: "unknown_team" } };
  const tenantId = routed.tenantId;

  const token = await slackTokenFor(deps.db, tenantId, team.id);
  if (!token.ok) return reply("OASIS cannot check who you are in this Slack workspace right now. Decide this approval in OASIS.", false);
  const who = await resolveSlackIdentity(deps.db, { tenantId, teamId: team.id, slackUserId: user.id, token: token.token, now, fetchImpl: deps.fetchImpl });
  if (!who.ok) return reply("OASIS could not check who you are in Slack just now. Try again, or decide this approval in OASIS.", false);
  const id = who.identity;
  if (id.isGuest || id.isExternal || !id.profileId) {
    return reply("Only an owner or admin of this OASIS workspace can approve from Slack, and your Slack email is not linked to one. Decide it in OASIS.", false);
  }
  const profile = await profileInTenant(deps.db, tenantId, id.profileId);
  const isTrueAdmin = !!profile && (profile.is_owner === 1 || ["owner", "admin"].includes((profile.team_role || "").toLowerCase()));
  if (!profile || profile.deactivated_at || !isTrueAdmin) {
    return reply("Only an owner or admin of this OASIS workspace can approve from Slack. Decide it in OASIS.", false);
  }
  const persona = resolvePersona({ teamRole: profile.team_role, isTrueAdmin: true });
  const scope = approvalScopeFor({
    tenantId,
    userId: profile.auth_user_id,
    persona,
    canAct: SURFACE_CAPABILITIES[persona].canAct,
    openDepartments: new Set(DEPARTMENT_KEYS),
  });

  const decided = await decideApproval(deps.db, scope, button.approvalId, { kind: "approve", payloadHash: button.payloadHash }, now, "slack");
  if (!decided.ok) {
    const current = decided.error === "not_pending" && decided.status === "approved" ? await getApproval(deps.db, scope, button.approvalId) : null;
    const resumable = !!current && current.status === "approved" && current.payload_hash === button.payloadHash;
    if (!resumable) return reply(DECIDE_COPY[decided.error] ?? "This approval could not be decided from Slack. Open it in OASIS.", decided.error === "not_pending" || decided.error === "expired");
  }
  const executed = await executeApproval(
    deps.db,
    { tenantId, approvalId: button.approvalId, approver: { userId: profile.auth_user_id, email: profile.email }, now: deps.now },
    deps.executorDeps,
  );
  const done = executed.approval;
  const r = done?.execution_result;
  const by = id.displayName ? ` by ${id.displayName}` : "";
  if (!executed.ok && executed.error === "not_claimable") return reply("This approval is already being carried out. Nothing was posted twice.", true);
  if (done?.status === "executed" && r?.outcome === "sent") return reply(`Approved${by} in Slack. The reply is posted in this thread.`, true);
  if (done?.status === "executed" && r?.outcome === "dry_run") return reply(`Approved${by} in Slack, but not posted: this OASIS deployment is in dry-run for Slack.`, true);
  const why = r && r.outcome === "failed" ? r.message : "it could not be carried out.";
  return reply(`Approved${by} in Slack, but not posted: ${why}`, true);
}
