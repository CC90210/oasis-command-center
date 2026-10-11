/**
 * Who may CREATE a script automation: a verified platform operator, and no one
 * else (Automations guided setup, PR1).
 *
 * A script automation is code that runs on a paired machine. Until now any
 * workspace owner or admin could draft one with AI and save it, or post one to
 * /api/cron-jobs. Clients get department tasks instead (standing instructions
 * the server runs, with approval cards), so the three create doors now ask the
 * same verified question lib/platform-operator.ts answers everywhere else:
 * operator alias or listed founder id, AND an owner/admin seat in OASIS's own
 * workspace, by auth id. Existing client script rows keep their canManageTeam
 * toggle and edit (app/api/cron-jobs/[id]); only creation moves.
 *
 * Two halves, both here so the rule has one home:
 *   - gateScriptAutomationCreate(): the route gate. Fails CLOSED and says why:
 *     401 signed out, 403 not an admin of this workspace, 403
 *     script_automations_operator_only, and 503 when the operator check itself
 *     could not be read (an outage is not a verdict about the person).
 *   - scriptAccessFrom(): the page's answer, from the same check, as a
 *     three-way value the UI renders honestly ("unknown" is not "no").
 */

import { NextResponse } from "next/server";
import { canManageTeam, getSessionContext, type SessionContext } from "@/lib/team";
import { getSessionUser } from "@/lib/supabase-server";
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
 * The full verdict a mount needs before offering create controls: the verified
 * operator check AND the viewer's ACTIVE workspace seat can manage the team —
 * the exact two gates gateScriptAutomationCreate enforces (canManageTeam is
 * checked there before the operator question is even asked). scriptAccessFrom
 * alone answers only the first half, so a verified operator whose active seat
 * is a plain member in some workspace read "allowed" and saw create controls
 * every one of the three create routes then answered 403 to.
 *
 * "unknown" on a failed operator lookup is unchanged — that is scriptAccessFrom's
 * call. A missing or non-managing active seat resolves to "not_allowed", same as
 * the routes would answer; it is never promoted to "unknown" because there is no
 * failure to report, just an ordinary no.
 */
export async function resolveScriptAutomationAccess(
  check: PlatformOperatorCheck | null | undefined,
): Promise<ScriptAutomationAccess> {
  const operatorVerdict = scriptAccessFrom(check);
  if (operatorVerdict !== "allowed") return operatorVerdict;
  const ctx = await getSessionContext();
  return ctx && canManageTeam(ctx.teamRole, ctx.adminAccess) ? "allowed" : "not_allowed";
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
  const check = await resolvePlatformOperatorForAuthUser(ctx.authUserId, email);
  if (check.operator) return { ok: true, ctx, email };
  if (check.reason === "lookup_failed") return { ok: false, response: operatorCheckUnavailable() };
  return {
    ok: false,
    response: NextResponse.json(
      { ok: false, error: SCRIPT_AUTOMATIONS_OPERATOR_ONLY, message: SCRIPT_AUTOMATIONS_OPERATOR_ONLY_MESSAGE },
      { status: 403 },
    ),
  };
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
