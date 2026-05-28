/**
 * OAuth + email-confirm callback. Exchanges the magic ?code= param for a
 * session cookie, then redirects to the requested next page.
 *
 * Invite callbacks redeem into the inviter's tenant and skip fresh-tenant
 * provisioning. Non-invite OAuth/email-confirm signups provision directly
 * from the authenticated Supabase user; no browser-supplied auth_user_id is
 * trusted.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { provisionAuthenticatedUser } from "@/lib/auth-provisioning";
import { getServiceSupabase } from "@/lib/supabase-server";
import { redeemInvite } from "@/lib/team";
import { DEMO_CLIENT_PROFILE_COOKIE } from "@/lib/client-profiles";
import { resolvePostLoginRedirect } from "@/lib/auth-routing";

const PENDING_INVITE_COOKIE = "pending_invite_token";

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/";
  const brandHint = searchParams.get("brand")?.trim() || "";
  const fullNameHint = searchParams.get("full_name")?.trim() || "";
  const inviteHint = searchParams.get("invite")?.trim() || "";

  if (!code) return NextResponse.redirect(`${origin}/login?err=missing_code`);

  const url = process.env.BRAVO_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const res = NextResponse.redirect(`${origin}${next}`);

  const supa = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(toSet) {
        toSet.forEach(({ name, value, options }) =>
          res.cookies.set({ name, value, ...options }),
        );
      },
    },
  });

  const { data, error } = await supa.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return NextResponse.redirect(
      `${origin}/login?err=${encodeURIComponent(error?.message || "session_failed")}`,
    );
  }
  res.cookies.set({ name: DEMO_CLIENT_PROFILE_COOKIE, value: "", maxAge: 0, path: "/" });

  const pendingInviteToken = inviteHint || req.cookies.get(PENDING_INVITE_COOKIE)?.value;
  if (pendingInviteToken) {
    res.cookies.set({ name: PENDING_INVITE_COOKIE, value: "", maxAge: 0, path: "/" });
    const redeemed = await redeemInvite(pendingInviteToken, data.user.id);
    if (redeemed.ok) {
      // Route to /onboarding/welcome on first-login (invitee path); the
      // hardcoded `next` already accounts for this in signup/login URL
      // construction, but be explicit here so OAuth + invite always lands
      // on the wizard rather than the requested `next` (which can be `/`).
      res.headers.set("Location", `${origin}/onboarding/welcome`);
      return res;
    }
    // Redeem failed — sign the user OUT to undo the cookie write, then
    // bounce them to /login with a human-readable error. Silently falling
    // through to provisionAuthenticatedUser would create a brand-new
    // tenant for them, stranding them outside the invite's workspace
    // (data-integrity leak across tenants).
    const reason = (redeemed.error || "").toLowerCase();
    let errCode = "invite_redeem_failed";
    if (reason.includes("email_mismatch")) errCode = "invite_email_mismatch";
    else if (reason.includes("invalid_or_expired")) errCode = "invite_expired";
    // supa.auth.signOut() writes the session-cookie expirations to `res`
    // via the createServerClient cookie adapter above. Returning a fresh
    // NextResponse.redirect() here would drop those Set-Cookie headers
    // and leave the browser signed in (Codex P2). Reuse `res` so the
    // sign-out cookies actually travel back to the client.
    //
    // Scope MUST be "local" — the default "global" revokes every refresh
    // token across every device for this user, which is wildly out of
    // proportion when their only mistake was clicking a stale invite or
    // signing in with the wrong Google account (Codex P2 #2). We only
    // want to clear the session this very callback just established.
    await supa.auth.signOut({ scope: "local" });
    res.headers.set("Location", `${origin}/login?err=${encodeURIComponent(errCode)}`);
    return res;
  }

  try {
    if (!data.user.email) throw new Error("missing_email");
    await provisionAuthenticatedUser({
      db: getServiceSupabase(),
      authUserId: data.user.id,
      email: data.user.email,
      fullName:
        fullNameHint ||
        (data.user.user_metadata?.full_name as string) ||
        (data.user.user_metadata?.name as string) ||
        (data.user.email?.split("@")[0] ?? "User"),
      brand: brandHint || (data.user.user_metadata?.brand as string) || "OASIS AI",
    });
  } catch (provisioningErr) {
    // Don't block sign-in if provisioning hiccups; Settings can re-trigger.
    // Log so we can spot if the redirect-bounce-to-onboarding fallback
    // is being hit because of a real provisioning failure (vs the more
    // benign read-replica lag handled in resolvePostLoginRedirect).
    console.warn(
      "[auth/callback] provisionAuthenticatedUser failed:",
      provisioningErr instanceof Error ? provisioningErr.message : provisioningErr,
    );
  }

  const postLoginPath = await resolvePostLoginRedirect({
    db: getServiceSupabase(),
    authUserId: data.user.id,
    email: data.user.email,
    requestedNext: next,
  }).catch(() => "/");
  res.headers.set("Location", `${origin}${postLoginPath}`);
  return res;
}
