/**
 * Who may CREATE a script automation: the workspace's AGENTS OWNER, or (for a
 * workspace that has never had an agents-owner row) the pre-O2 verified
 * platform operator rule (Automations guided setup PR1; tightened O2,
 * 2026-10-11).
 *
 * A script automation (script_run / snapshot_run / webhook_post) is code that
 * runs on a paired machine. #580 gated creation on "operator AND canManageTeam"
 * — but PR #576 made Adon a verified platform operator too, so that rule let
 * him create script automations CCPC alone can run. Only CCPC's owner (the
 * agents owner, lib/agents-owner.ts, database/turso/bravo__210_workspace_agents_owner.sql)
 * may create one now. A workspace that has never had an owner row (every
 * client tenant today) keeps the old rule unchanged — this is what "the
 * client-tenant behavior from #580 stays intact" means: nothing here narrows a
 * client owner's access, because clients never reach the agents-owner branch
 * at all.
 *
 * Department tasks (the O5 kind any owner/admin may create) are a DIFFERENT
 * action_type and never reach this gate; see action-types.ts.
 *
 * Two halves, both here so the rule has one home:
 *   - gateScriptAutomationCreate(): the route gate. Fails CLOSED and says why:
 *     401 signed out, 403 not an admin of this workspace, 403
 *     script_automations_operator_only, and 503 when the agents-owner read or
 *     (on the fallback path) the operator check itself could not be read (an
 *     outage is not a verdict about the person).
 *   - scriptAccessFrom() / resolveScriptAutomationAccess(): the page's answer,
 *     from the same checks, as a three-way value the UI renders honestly
 *     ("unknown" is not "no").
 */

import { NextResponse } from "next/server";
import { canManageTeam, getSessionContext, type SessionContext } from "@/lib/team";
import { getSessionUser } from "@/lib/supabase-server";
import { readAgentsOwner } from "@/lib/agents-owner";
import {
  resolvePlatformOperatorForAuthUser,
  type PlatformOperatorCheck,
} from "@/lib/platform-operator";

export const SCRIPT_AUTOMATIONS_OPERATOR_ONLY = "script_automations_operator_only" as const;

/** The sentence a non-operator gets from the API and, in other words, the page. */
export const SCRIPT_AUTOMATIONS_OPERATOR_ONLY_MESSAGE =
  "Script automations are set up by OASIS. New automations are coming to this page.";

export type ScriptAutomationAccess = "allowed" | "not_allowed" | "unknown";

/** The page's view of the operator check. A failed lookup is "unknown", never "not_allowed". */
export function scriptAccessFrom(check: PlatformOperatorCheck | null | undefined): ScriptAutomationAccess {
  if (!check) return "not_allowed";
  if (check.operator) return "allowed";
  return check.reason === "lookup_failed" ? "unknown" : "not_allowed";
}

/**
 * O2's tightened verdict: is `authUserId` allowed to create a script
 * automation in `tenantId`?
 *   - this workspace has a LIVE agents owner and `authUserId` is them: allowed.
 *   - this workspace has a live agents owner and it is someone else, or the
 *     row is revoked (a lock with no key, never "no lock"): not_allowed.
 *   - the read itself failed: unknown — an outage is not a verdict about the
 *     person.
 *   - this workspace has NEVER had an agents-owner row (every client tenant
 *     today): fall through to the pre-O2 rule unchanged — this is the half
 *     of #580 that keeps a client owner's access exactly as it was.
 */
async function agentsOwnerCreateVerdict(
  tenantId: string,
  authUserId: string,
  check: PlatformOperatorCheck | null | undefined,
): Promise<ScriptAutomationAccess> {
  const owner = await readAgentsOwner(tenantId);
  if (owner.state === "set") return owner.authUserId === authUserId ? "allowed" : "not_allowed";
  if (owner.state === "unavailable") return "unknown";
  if (owner.state === "revoked") return "not_allowed";
  return scriptAccessFrom(check);
}

/**
 * The full verdict a mount needs before offering create controls: the
 * viewer's ACTIVE workspace seat can manage the team, AND — the exact two
 * gates gateScriptAutomationCreate enforces, in the same order (canManageTeam
 * is checked there before the agents-owner question is even asked) —
 * agentsOwnerCreateVerdict above. scriptAccessFrom alone answers only the old
 * operator half, so a verified operator whose active seat is a plain member
 * in some workspace read "allowed" and saw create controls every one of the
 * three create routes then answered 403 to.
 *
 * A missing or non-managing active seat resolves to "not_allowed", same as
 * the routes would answer; it is never promoted to "unknown" because there is
 * no failure to report, just an ordinary no.
 */
export async function resolveScriptAutomationAccess(
  check: PlatformOperatorCheck | null | undefined,
): Promise<ScriptAutomationAccess> {
  const ctx = await getSessionContext();
  if (!ctx || !canManageTeam(ctx.teamRole, ctx.adminAccess)) return "not_allowed";
  return agentsOwnerCreateVerdict(ctx.tenantId, ctx.authUserId, check);
}

export type ScriptCreateGate =
  | { ok: true; ctx: SessionContext; email: string | null }
  | { ok: false; response: NextResponse };

/**
 * Gate for every route that creates a script automation. `forbiddenMessage` is
 * the route's existing wording for a member who cannot manage the workspace.
 */
export async function gateScriptAutomationCreate(forbiddenMessage: string): Promise<ScriptCreateGate> {
  const ctx = await getSessionContext();
  if (!ctx) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  if (!canManageTeam(ctx.teamRole, ctx.adminAccess)) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "forbidden", message: forbiddenMessage }, { status: 403 }),
    };
  }
  // The auth user's own (session) email, never a profile column: see
  // resolvePlatformOperatorForAuthUser for why a profile email is a squat.
  let email: string | null = null;
  try {
    const user = await getSessionUser();
    if (!user || user.id !== ctx.authUserId) {
      return { ok: false, response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
    }
    email = user.email ?? null;
  } catch (err) {
    console.error("[automations.script_access] session read failed", err);
    return { ok: false, response: operatorCheckUnavailable() };
  }
  // O2: the agents owner of THIS workspace, or — only when this workspace has
  // never had an owner row at all — the pre-O2 verified-operator rule. A live
  // owner row naming someone else, or a revoked one, is a flat refusal with no
  // fallback: see agentsOwnerCreateVerdict's doc comment.
  const owner = await readAgentsOwner(ctx.tenantId);
  if (owner.state === "set") {
    if (owner.authUserId === ctx.authUserId) return { ok: true, ctx, email };
    return { ok: false, response: scriptAutomationsOperatorOnly() };
  }
  if (owner.state === "unavailable") return { ok: false, response: operatorCheckUnavailable() };
  if (owner.state === "revoked") return { ok: false, response: scriptAutomationsOperatorOnly() };

  const check = await resolvePlatformOperatorForAuthUser(ctx.authUserId, email);
  if (check.operator) return { ok: true, ctx, email };
  if (check.reason === "lookup_failed") return { ok: false, response: operatorCheckUnavailable() };
  return { ok: false, response: scriptAutomationsOperatorOnly() };
}

function scriptAutomationsOperatorOnly(): NextResponse {
  return NextResponse.json(
    { ok: false, error: SCRIPT_AUTOMATIONS_OPERATOR_ONLY, message: SCRIPT_AUTOMATIONS_OPERATOR_ONLY_MESSAGE },
    { status: 403 },
  );
}

function operatorCheckUnavailable(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "operator_check_unavailable",
      message: "We couldn't confirm your access just now, so nothing was created. Try again in a minute.",
    },
    { status: 503 },
  );
}
