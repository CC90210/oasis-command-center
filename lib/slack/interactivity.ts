/**
 * lib/slack/interactivity.ts - the "Approve and post" button on the review
 * card (sent only to the owner or admin who asked: lib/slack/send.ts).
 *
 * TWO HALVES, BECAUSE OF SLACK'S 3 SECONDS. Slack wants a block_actions press
 * acknowledged within 3 seconds, or the presser sees "the app did not
 * respond" (and may press again). The work of a press can take longer: a
 * users.info lookup, the decision, the chat.postMessage and the response_url
 * update each have their own timeouts. So:
 *   acceptSlackInteraction   verify the signature and read the press. Fast, no
 *                            network. Answers 401/400/503 itself, and hands
 *                            back the press's work.
 *   work()                   everything else; the route runs it AFTER Slack
 *                            has its 200 (next/server after(), the Worker's
 *                            waitUntil) and the outcome reaches the presser
 *                            through response_url, as it always did.
 * handleSlackInteractivity runs both in order (the tests).
 *
 * WHO MAY PRESS IT. The Slack user must be a full member of the connected team
 * (no guest, no other company) whose verified email is an ACTIVE owner or admin
 * of the same OASIS workspace (lib/slack/identity.ts slackApproverProfile).
 * Anyone else is told to decide in OASIS, and nothing is decided.
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
import { isSlackResponseUrl, respondToAction, type SlackFetch } from "@/lib/slack/client";
import { verifySlackRequest } from "@/lib/slack/verify";
import { slackAppMaySpeakFor, type SlackRequestApp } from "@/lib/slack/own-app";
import { resolveSlackIdentity, slackApproverProfile } from "@/lib/slack/identity";
import { APPROVE_ACTION_ID, parseApproveButtonValue, slackTokenFor } from "@/lib/slack/send";
import { isSlackTeamId, isSlackUserId } from "@/lib/slack/routing";

type Env = Readonly<Record<string, string | undefined>>;

export type InteractivityDeps = {
  db: Client;
  now: () => Date;
  env?: Env;
  /**
   * The app whose signing secret `env` holds (lib/slack/own-app.ts
   * slackRequestScope gives both): OASIS's when absent, as `env` is then the
   * Worker's own. On EVERY press, the workspace its team is routed to must use
   * that app (slackAppMaySpeakFor) before anything is decided.
   */
  app?: SlackRequestApp;
  fetchImpl?: SlackFetch;
  executorDeps?: ExecutorDeps;
};

export type InteractivityResult = { status: number; body: Record<string, unknown>; replaced?: string };

export type AcceptedInteraction = {
  /** What Slack is answered NOW. */
  status: number;
  body: Record<string, unknown>;
  /** The press's work, to run after the answer. Absent when there is nothing to do. */
  work?: () => Promise<InteractivityResult>;
  /** Slack's response_url for this press (Slack's own host only), where a failure after the answer is reported. */
  responseUrl: string | null;
};

const DECIDE_COPY: Record<string, string> = {
  not_found: "That approval is not in this workspace any more.",
  not_pending: "Someone already decided this approval. Nothing was posted twice.",
  expired: "This approval expired before anyone decided it. Ask again in the thread.",
  payload_mismatch: "This draft changed after the card was posted. Open it in OASIS to see the current version.",
  forbidden: "You can see this approval but you cannot decide it.",
};

/** The sentence a presser gets when the work after the answer failed outright. */
export const PRESS_FAILED_COPY = "OASIS could not finish this. Check the approval in OASIS before you press again.";

export async function acceptSlackInteraction(
  input: { rawBody: string; timestamp: string | null; signature: string | null },
  deps: InteractivityDeps,
): Promise<AcceptedInteraction> {
  const verified = verifySlackRequest({ rawBody: input.rawBody, timestamp: input.timestamp, signature: input.signature, nowMs: deps.now().getTime(), env: deps.env });
  if (!verified.ok) {
    if (verified.reason === "not_configured") return { status: 503, body: { ok: false, error: "slack_not_configured" }, responseUrl: null };
    return { status: 401, body: { ok: false, error: verified.reason }, responseUrl: null };
  }
  let payload: Record<string, unknown>;
  try {
    const raw = new URLSearchParams(input.rawBody).get("payload");
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return { status: 400, body: { ok: false, error: "payload_invalid" }, responseUrl: null };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: "payload_invalid" }, responseUrl: null };
  }
  if (payload.type !== "block_actions") return { status: 200, body: { ok: true, ignored: "not_a_button" }, responseUrl: null };
  const actions = Array.isArray(payload.actions) ? (payload.actions as Array<Record<string, unknown>>) : [];
  const action = actions.find((a) => a && a.action_id === APPROVE_ACTION_ID);
  if (!action) return { status: 200, body: { ok: true, ignored: "other_action" }, responseUrl: null };
  const button = parseApproveButtonValue(action.value);
  const team = (payload.team && typeof payload.team === "object" ? payload.team : {}) as Record<string, unknown>;
  const user = (payload.user && typeof payload.user === "object" ? payload.user : {}) as Record<string, unknown>;
  const responseUrl = isSlackResponseUrl(payload.response_url) ? payload.response_url : null;
  if (!button || !isSlackTeamId(team.id) || !isSlackUserId(user.id)) return { status: 200, body: { ok: true, ignored: "malformed" }, responseUrl: null };
  const press = { approvalId: button.approvalId, payloadHash: button.payloadHash, teamId: team.id, slackUserId: user.id, responseUrl };
  return { status: 200, body: { ok: true }, responseUrl, work: () => decidePress(press, deps) };
}

async function decidePress(
  press: { approvalId: string; payloadHash: string; teamId: string; slackUserId: string; responseUrl: string | null },
  deps: InteractivityDeps,
): Promise<InteractivityResult> {
  const now = deps.now();
  const reply = async (text: string, replace: boolean): Promise<InteractivityResult> => {
    if (press.responseUrl) {
      const r = await respondToAction(
        press.responseUrl,
        replace ? { replace_original: true, text } : { response_type: "ephemeral", replace_original: false, text },
        { fetchImpl: deps.fetchImpl },
      );
      if (!r.ok) console.error("[slack.interactivity] could not update the card", { error: r.error });
    }
    return { status: 200, body: { ok: true }, replaced: text };
  };

  const routed = await resolveWebhookRoute(deps.db, "slack", press.teamId);
  if (!routed) return { status: 200, body: { ok: true, ignored: "unknown_team" } };
  const app: SlackRequestApp = deps.app ?? { kind: "oasis" };
  if (!slackAppMaySpeakFor(app, routed.tenantId)) {
    console.error("[slack.interactivity] a press named a Slack team whose workspace does not use the app that signed it; ignored", {
      app: app.kind,
      ...(app.kind === "own" ? { workspace: app.tenantId } : {}),
      routedTenantId: routed.tenantId,
    });
    return { status: 200, body: { ok: true, ignored: "team_not_this_workspace" } };
  }
  const tenantId = routed.tenantId;

  const token = await slackTokenFor(deps.db, tenantId, press.teamId, { id: routed.connectionId, generation: routed.generation });
  if (!token.ok) return reply("OASIS cannot check who you are in this Slack workspace right now. Decide this approval in OASIS.", false);
  const who = await resolveSlackIdentity(deps.db, { tenantId, teamId: press.teamId, slackUserId: press.slackUserId, token: token.token, now, fetchImpl: deps.fetchImpl });
  if (!who.ok) return reply("OASIS could not check who you are in Slack just now. Try again, or decide this approval in OASIS.", false);
  const id = who.identity;
  if (id.isGuest || id.isExternal || !id.profileId) {
    return reply("Only an owner or admin of this OASIS workspace can approve from Slack, and your Slack email is not linked to one. Decide it in OASIS.", false);
  }
  const approver = await slackApproverProfile(deps.db, tenantId, id.profileId);
  if (!approver) {
    return reply("Only an owner or admin of this OASIS workspace can approve from Slack. Decide it in OASIS.", false);
  }
  const persona = resolvePersona({ teamRole: approver.teamRole, isTrueAdmin: true });
  const scope = approvalScopeFor({
    tenantId,
    userId: approver.authUserId,
    persona,
    canAct: SURFACE_CAPABILITIES[persona].canAct,
    openDepartments: new Set(DEPARTMENT_KEYS),
  });

  const decided = await decideApproval(deps.db, scope, press.approvalId, { kind: "approve", payloadHash: press.payloadHash }, now, "slack");
  if (!decided.ok) {
    const current = decided.error === "not_pending" && decided.status === "approved" ? await getApproval(deps.db, scope, press.approvalId) : null;
    const resumable = !!current && current.status === "approved" && current.payload_hash === press.payloadHash;
    if (!resumable) return reply(DECIDE_COPY[decided.error] ?? "This approval could not be decided from Slack. Open it in OASIS.", decided.error === "not_pending" || decided.error === "expired");
  }
  const executed = await executeApproval(
    deps.db,
    { tenantId, approvalId: press.approvalId, approver: { userId: approver.authUserId, email: approver.email }, now: deps.now },
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

/** The press's work, run after the answer, threw: tell the presser (Slack shows nothing otherwise). */
export async function reportPressFailure(responseUrl: string | null, opts: { fetchImpl?: SlackFetch } = {}): Promise<void> {
  if (!responseUrl) return;
  const r = await respondToAction(responseUrl, { response_type: "ephemeral", replace_original: false, text: PRESS_FAILED_COPY }, { fetchImpl: opts.fetchImpl });
  if (!r.ok) console.error("[slack.interactivity] could not tell the presser the press failed", { error: r.error });
}

/** Accept, then do the work, in order: the whole press as one call. */
export async function handleSlackInteractivity(
  input: { rawBody: string; timestamp: string | null; signature: string | null },
  deps: InteractivityDeps,
): Promise<InteractivityResult> {
  const accepted = await acceptSlackInteraction(input, deps);
  if (!accepted.work) return { status: accepted.status, body: accepted.body };
  return accepted.work();
}
