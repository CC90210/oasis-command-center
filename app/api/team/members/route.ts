import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getAuthedSupabase } from "@/lib/supabase-server";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";
import { systemCalendarConfig } from "@/lib/integrations/google-calendar";
import {
  canManageTeam,
  isTrueAdminRole,
  getSessionContext,
  getTenantMembers,
  removeMember,
  setMemberRole,
  type TeamRole,
} from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLE_VALUES: TeamRole[] = [
  "admin",
  "member",
  "agent",
];

const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Can this refresh token actually be spent? Asks Google, because there is no
 * local signal for revocation.
 *
 * FAILS CLOSED, WITH ONE DELIBERATE EXCEPTION. A definitive rejection from
 * Google (HTTP 4xx -- `invalid_grant` for a revoked or withdrawn token) means
 * NOT connected, and the banner must say so. But a TRANSPORT failure, or a 5xx
 * from Google, means we do not know: reporting "reconnect Google" to a host
 * whose connection is fine, because Google had a bad minute, sends a rep off to
 * re-authorise something that was never broken. Unknown therefore preserves the
 * previous belief (the cheap checks already passed) rather than inventing a
 * verdict in either direction.
 *
 * The distinction matters because the two errors have opposite remedies: one
 * needs a human at a consent screen, the other needs nobody to do anything.
 *
 * Cost: one token call per connected host per request, and only for hosts who
 * already pass the token/scope/identity checks. It buys the difference between
 * a banner that is true and a banner that is decorative.
 */
/**
 * Verdict cache, 60 seconds, keyed on the token itself.
 *
 * CREDITED TO CC's REVIEW (2026-08-26), which caught a real flaw in the first
 * version of this: it called Google once per connected host on EVERY request.
 * A team of ten reps loading the handoff form is ten token calls, and this
 * endpoint is hit on every page that needs the member list. That is a rate-limit
 * incident waiting to happen, and Google's response to being hammered is to
 * start failing the very calls this check depends on.
 *
 * Keyed on the token string, not on a user id, so reconnecting with a NEW token
 * is a new key and is verified immediately rather than waiting out the TTL. The
 * stale window therefore only ever applies to a token that has not changed --
 * which is the case where the previous answer is still the best one available.
 *
 * 60s is the deliberate trade: a token revoked at Google is believed for at most
 * a minute, and a rep who books inside that window gets the workspace fallback
 * (google-calendar.ts, PR #324) rather than a failure -- so the worst case is a
 * booking organised by the shared address instead of the host, not a lost
 * booking. Without that fallback this TTL would be far riskier.
 */
const TOKEN_VERDICT_TTL_MS = 60_000;
const tokenVerdicts = new Map<string, { ok: boolean; expires: number }>();

async function tokenUsable(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): Promise<boolean> {
  const now = Date.now();
  // Keyed on client too: the same token string presented by a different OAuth
  // client is a genuinely different question, and Google answers it differently.
  const key = `${clientId || ""}:${refreshToken}`;
  const cached = tokenVerdicts.get(key);
  if (cached && cached.expires > now) return cached.ok;
  const verdict = await probeToken(refreshToken, clientId, clientSecret);
  tokenVerdicts.set(key, { ok: verdict, expires: now + TOKEN_VERDICT_TTL_MS });
  // Bound the map so a long-lived instance cycling through many tokens cannot
  // grow it without limit. Cheap because entries are tiny and short-lived.
  if (tokenVerdicts.size > 500) {
    for (const [k, v] of tokenVerdicts) if (v.expires <= now) tokenVerdicts.delete(k);
  }
  return verdict;
}

async function probeToken(
  refreshToken: string,
  overrideClientId?: string,
  overrideClientSecret?: string,
): Promise<boolean> {
  const clientId =
    overrideClientId || process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    overrideClientSecret ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET;
  // No OAuth config is a deployment problem, not a host problem. Nothing can
  // book in that state, so claiming a host is ready would be the bigger lie.
  if (!clientId || !clientSecret) return false;
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) return true;
    // 4xx is Google's definitive "this token is dead". 5xx is Google's problem.
    if (res.status >= 400 && res.status < 500) return false;
    return true;
  } catch {
    // Timeout or network error: unknown, not dead. See the doc comment.
    return true;
  }
}

async function calendarReadiness(tenantId: string, userId: string | null, profileEmail: string | null) {
  if (!userId) {
    return {
      calendar_connected: false,
      calendar_reconnect_required: false,
      calendar_identity_mismatch: false,
      connected_google_address: null,
    };
  }
  try {
    const bundle = await getUserIntegrationBundle(tenantId, userId, "gmail_oauth");
    // ═══ PRESENCE IS NOT VALIDITY ═══════════════════════════════════════════
    //
    // This read `Boolean(bundle.refresh_token)` and called it connected. That is
    // a check that a STRING EXISTS. A refresh token that Google has REVOKED is
    // still a perfectly good-looking string sitting in that column, and Google
    // only tells you otherwise when you try to spend it -- which happens inside
    // the booking call, long after this banner has gone green.
    //
    // That produced the exact sequence the operator hit on 2026-08-26: the
    // handoff form said "Google Calendar is ready for this host", the rep filled
    // in the whole form, ticked three confirmations, clicked Book, and got a raw
    // `token_refresh_failed` on screen with no idea what to do. The readiness
    // check and the booking were asking different questions.
    //
    // `tokenUsable()` asks the SAME question the booking asks: it spends the
    // refresh token against Google's token endpoint. Revocation has no local
    // signal at all -- checking an `expires_at` column would not have caught
    // this, because the token had not expired, it had been withdrawn.
    const hasToken = Boolean(bundle.refresh_token);
    const scopes = new Set((bundle.scope || "").split(/\s+/u).filter(Boolean));
    const connectedAddress = String(bundle.gmail_address || "").trim().toLowerCase();
    const expectedAddress = String(profileEmail || "").trim().toLowerCase();
    const identityMatches = Boolean(connectedAddress && expectedAddress && connectedAddress === expectedAddress);
    // Only spend a network call when the cheap checks already pass -- a host
    // with no token or the wrong scope is not connected regardless of Google.
    const workspaceConnected =
      hasToken && scopes.has(CALENDAR_EVENTS_SCOPE) && identityMatches
        ? await tokenUsable(String(bundle.refresh_token))
        : false;
    // ═══ THESE TWO FLAGS WERE ALWAYS FALSE ═════════════════════════════════
    //
    // They read `workspaceConnected && !calendarConnected` and
    // `workspaceConnected && ... && !identityMatches`. When `calendarConnected`
    // was collapsed to equal `workspaceConnected` (PR #322), the first became
    // `X && !X` -- a contradiction, false for every host forever. The second was
    // already unreachable: `workspaceConnected` REQUIRES `identityMatches`, so
    // `workspaceConnected && !identityMatches` can never hold.
    //
    // The cost was not cosmetic. A host whose token Google had revoked reported
    // `calendar_reconnect_required: false`, so the UI never showed the one
    // instruction that would have fixed it -- reconnect Google once -- and a rep
    // was left with a disabled button and no route forward. A flag that is
    // structurally incapable of being true is worse than an absent flag: it
    // reads as a definite "no problem here". (Caught by CC's agent, 2026-08-26.)
    //
    // Each is now derived from the INPUTS rather than from the conclusion, so no
    // flag can depend on the thing it is meant to explain.
    const calendarConnected = workspaceConnected;
    const identityMismatch = hasToken && Boolean(connectedAddress && expectedAddress) && !identityMatches;
    // A token that exists but does not work, for any reason OTHER than the host
    // having connected the wrong account -- that case gets its own, more
    // specific message and must not be flattened into a generic "reconnect".
    const reconnectRequired = hasToken && !calendarConnected && !identityMismatch;
    return {
      calendar_connected: calendarConnected,
      calendar_reconnect_required: reconnectRequired,
      calendar_identity_mismatch: identityMismatch,
      connected_google_address: connectedAddress || null,
    };
  } catch (err) {
    // Host readiness fails closed. Never include decrypted bundle fields in
    // either the log or the response.
    console.error("[team.members] Google Workspace readiness lookup failed", {
      tenantId,
      userId,
      error: err instanceof Error ? err.message : "lookup_failed",
    });
    return {
      calendar_connected: false,
      calendar_reconnect_required: false,
      calendar_identity_mismatch: false,
      connected_google_address: null,
    };
  }
}

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  const members = await getTenantMembers(ctx.tenantId);
  const canManage = canManageTeam(ctx.teamRole, ctx.adminAccess);
  // Workspace fallback (2026-08-25): when the OASIS workspace Calendar
  // credentials are configured, a host WITHOUT a personal work connection can
  // still be booked — the event is organized by the workspace account and the
  // host is invited as an attendee. Reporting every host as calendar-ready
  // here is what removes the false "needs to reconnect Google Calendar" card
  // from the audit handoff; per-host detail fields are preserved underneath.
  // ═══ PRESENCE IS NOT VALIDITY -- FOR THE SHARED CREDENTIAL TOO ══════════
  //
  // This was isSystemCalendarConfigured(): "the three env vars are non-empty".
  // That is the SAME check that was ripped out of the per-host path in #322 for
  // lying, and it lied here in exactly the same way, one level up and far more
  // expensively: a revoked or client-mismatched workspace token is still three
  // perfectly non-empty strings, so the handoff banner read "Ready to book from
  // the OASIS AI calendar" while NOTHING could book for ANYONE. Every host also
  // looked coverable by a fallback that was already dead.
  //
  // Now it spends the token the way the booking spends it. Same 60s cache and
  // same fail-soft-on-network-error rules as the per-host probe, and it is one
  // extra Google call per request at most, deduped across all hosts.
  const systemCalendar = systemCalendarConfig();
  const workspaceFallbackReady = systemCalendar
    ? await tokenUsable(
        systemCalendar.refreshToken,
        systemCalendar.clientId,
        systemCalendar.clientSecret,
      )
    : false;
  const membersWithCalendar = await Promise.all(
    members.map(async (member) => ({
      member,
      readiness: await calendarReadiness(ctx.tenantId, member.auth_user_id, member.email),
    })),
  );
  return NextResponse.json({
    ok: true,
    self_profile_id: ctx.profileId,
    self_role: ctx.teamRole,
    self_is_owner: ctx.isOwner,
    can_manage: canManage,
    system_calendar_fallback: workspaceFallbackReady,
    members: membersWithCalendar.map(({ member: m, readiness }) => ({
      id: m.id,
      // auth_user_id is required by the lead-drawer "Assign to" dropdown
      // (Phase 3 of multi-employee personalization, 2026-05-29). Safe to
      // expose to every tenant member — it's the same UUID that surfaces
      // in chat session headers and other already-public identifiers.
      auth_user_id: m.auth_user_id,
      // Tenant teammates need the selected audit host's address so the
      // prefilled Google Calendar event actually invites that founder/closer.
      // This never crosses the tenant boundary and contains no provider secret.
      email: m.email,
      full_name: m.full_name,
      display_name: m.display_name,
      team_role: m.team_role,
      is_owner: m.is_owner,
      joined_at: m.joined_at,
      // ═══ THIS HOST'S OWN CONNECTION, AND NOTHING ELSE ═══════════════════
      //
      // This used to be `readiness.calendar_connected || workspaceFallbackReady`.
      // `workspaceFallbackReady` is isSystemCalendarConfigured() -- a GLOBAL
      // ENVIRONMENT CHECK with nothing to do with the selected host. So whenever
      // the system calendar was configured, EVERY host in the dropdown reported
      // connected, including hosts who had never linked a Google account, and the
      // UI rendered "Google Calendar is ready for this host" over the top of it.
      // The sentence made a claim about a specific person that the value behind
      // it did not support.
      //
      // The fallback is still available and still returned -- as
      // `system_calendar_fallback` at the top level, which is a DIFFERENT fact
      // and deserves a different sentence. Booking through the shared workspace
      // identity is not the same promise as booking as the host: the event is
      // organised by the shared account, which is fine for a client-facing
      // founder audit and deliberately REFUSED for private rep reminders (see
      // the rep-calendar path, which will not fall back because it would publish
      // a rep's own call notes to the whole workspace). Collapsing the two facts
      // into one boolean is what made that distinction invisible here.
      calendar_connected: readiness.calendar_connected,
      // Reconnect is now about the HOST, so the fallback no longer suppresses
      // it. A host whose token Google has revoked needs to reconnect whether or
      // not a shared calendar could cover for them -- suppressing the prompt is
      // how a dead connection stays dead for weeks.
      calendar_reconnect_required: readiness.calendar_reconnect_required,
      calendar_identity_mismatch: readiness.calendar_identity_mismatch,
      connected_google_address: readiness.connected_google_address,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  // ESCALATION GUARD: changing a member's role is a TRUE-admin action only —
  // canManageTeam() WITHOUT adminAccess is strict owner/admin. A toggled agent
  // (admin_access) must NOT be able to grant/alter roles. setMemberRole enforces
  // the same true-admin check internally as the authoritative backstop.
  if (!canManageTeam(ctx.teamRole)) return bad(403, "forbidden");

  let body: { profile_id?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }
  if (!body.profile_id) return bad(400, "missing profile_id");
  const newRole = body.role as TeamRole;
  if (!ROLE_VALUES.includes(newRole)) return bad(400, "invalid role");

  try {
    await setMemberRole({
      tenantId: ctx.tenantId,
      targetProfileId: body.profile_id,
      newRole,
      actor: ctx,
    });
    // Audit-log the role change (Phase D).
    try {
      const authed = await getAuthedSupabase();
      await authed.rpc("log_tenant_event", {
        p_tenant_id: ctx.tenantId,
        p_action_type: "member.role_change",
        p_target_table: "user_profiles",
        p_target_id: body.profile_id,
        p_after: { team_role: newRole },
      });
    } catch {
      // audit-log soft-fail
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "update_failed";
    const status =
      msg === "forbidden"
        ? 403
        : msg === "cannot_demote_owner" || msg === "ownership_transfer_not_supported"
          ? 409
          : msg === "member_not_found"
            ? 404
            : 500;
    return bad(status, msg);
  }
}

export async function DELETE(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  // Member removal is high-consequence; restricted to a PERMANENT admin — the
  // admin_access grant does NOT confer it. Owner protected in removeMember.
  if (!isTrueAdminRole(ctx.teamRole, ctx.isOwner)) return bad(403, "forbidden");
  const url = new URL(req.url);
  const profileId = url.searchParams.get("profile_id");
  if (!profileId) return bad(400, "missing profile_id");
  try {
    await removeMember({
      tenantId: ctx.tenantId,
      targetProfileId: profileId,
      actor: ctx,
    });
    // Audit-log the removal (Phase D).
    try {
      const authed = await getAuthedSupabase();
      await authed.rpc("log_tenant_event", {
        p_tenant_id: ctx.tenantId,
        p_action_type: "member.remove",
        p_target_table: "user_profiles",
        p_target_id: profileId,
      });
    } catch {
      // audit-log soft-fail
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "remove_failed";
    const status =
      msg === "forbidden" ? 403 : msg === "cannot_remove_owner" ? 409 : msg === "member_not_found" ? 404 : 500;
    return bad(status, msg);
  }
}
