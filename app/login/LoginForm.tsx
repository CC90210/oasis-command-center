"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { authMode } from "@/lib/auth-client";
import { OasisLogo } from "@/components/brand/OasisLogo";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const inviteToken = (params.get("invite") || "").trim();
  // ?email=<addr>&fresh=1 is set by /signup after a successful invite
  // signup so the invitee lands here with their email pre-filled and a
  // contextual hint instead of an empty form.
  const emailHint = (params.get("email") || "").trim();
  const isFreshFromSignup = params.get("fresh") === "1";
  // The auth/callback route bounces here with ?err=<code> when an OAuth
  // invite redeem fails (email mismatch, expired token, etc). Surface a
  // human-readable copy instead of leaking error codes to the operator.
  const errCode = (params.get("err") || "").trim();
  const errHint = errCode
    ? errCode === "invite_email_mismatch"
      ? "The Google account you used doesn't match the email this invite was sent to. Sign in with the right account, or ask your admin to send a new invite."
      : errCode === "invite_expired"
        ? "That invite link has expired or was already used. Sign in with your existing account or ask for a fresh invite."
        : errCode === "invite_redeem_failed"
          ? "We couldn't complete the invite. Sign in below if you already have an account, or ask your admin to resend the invite."
          : errCode === "oauth_denied"
            ? "Google sign-in was cancelled. Your workspace invite is still here when you're ready to try again."
            : errCode === "no_account"
              ? "That Google account does not have a Command Center login yet. Use the invited email below, or reset its password."
              : errCode.startsWith("oauth_") || errCode === "auth_backend_unavailable"
                ? "Google sign-in couldn't be completed. Your workspace invite was preserved; try again or use your password."
                : null
    : null;
  // If there's an invite, post-login routes through the welcome wizard
  // (Phase C) so the new teammate sets their personal preferences before
  // landing on the dashboard. Otherwise honor the explicit ?next= param.
  const next = inviteToken ? "/onboarding/welcome" : params.get("next") || "/";
  const [email, setEmail] = useState(emailHint);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // Turso auth mode: same credentials, verified server-side against the
      // migrated hash store. Invite redemption below still works — the redeem
      // route resolves the user from the session either way.
      //
      // Gate reads the SERVER's answer, not NEXT_PUBLIC_EMPIRE_AUTH_BACKEND.
      // That mirror is a separate flag: with EMPIRE_AUTH_BACKEND=turso but the
      // NEXT_PUBLIC_ copy unset, this branch was skipped and login fell through
      // to Supabase — half-migrated auth that looks healthy until the day
      // Supabase is cancelled.
      //
      // Full-page assign (not router.push) is deliberate: the session is an
      // httpOnly cookie, and server components must re-render with it.
      if ((await authMode()) === "turso") {
        const r = await fetch("/api/auth/turso-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!r.ok) {
          setErr(r.status === 429 ? "Too many attempts — wait a few minutes."
                                  : "Invalid email or password.");
          return;
        }
        if (inviteToken) {
          const rr = await fetch("/api/auth/redeem-invite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw_token: inviteToken }),
          });
          const b = (await rr.json().catch(() => ({}))) as {
            ok?: boolean; message?: string; error?: string; tenant_slug?: string | null };
          if (!rr.ok || !b.ok) {
            setErr(b.message || b.error || "Invite redemption failed");
            return;
          }
          const slug = b.tenant_slug?.trim();
          window.location.assign(slug ? `/t/${slug}` : "/");
          return;
        }
        window.location.assign(`/auth/land?next=${encodeURIComponent(next)}`);
        return;
      }
      // Supabase path — still the rollback, so it stays wired until the
      // subscription is actually cancelled.
      const supa = getBrowserSupabase();
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      if (error) {
        setErr(error.message);
        return;
      }
      // If the user followed an invite link, redeem it against their
      // existing account before routing. The redeem RPC is atomic so a
      // second submit (network retry / refresh) is safe.
      if (inviteToken && data.user) {
        const r = await fetch("/api/auth/redeem-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_token: inviteToken }),
        });
        const body = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          message?: string;
          first_login?: boolean;
          tenant_slug?: string | null;
        };
        if (!r.ok || !body.ok) {
          setErr(body.message || body.error || "Invite redemption failed");
          return;
        }
        // redeemInvite() (server) now returns ok=true for the legitimate
        // "this user already redeemed this exact token" case (idempotent
        // path), so any !body.ok above is a real failure (expired, revoked,
        // email mismatch, etc.) and we surface it.
        //
        // Post-redeem routing (2026-05-29 fix): invitees joining an
        // existing tenant skip the new-tenant wizard and land directly
        // in their workspace (/t/<slug>). Falls back to "/" when the
        // server couldn't resolve a Command Center profile slug — the
        // welcome page itself also auto-redirects, so the fallback path
        // is safe.
        const slug = body.tenant_slug?.trim();
        router.push(slug ? `/t/${slug}` : "/");
        router.refresh();
        return;
      }
      router.push(`/auth/land?next=${encodeURIComponent(next)}`);
      router.refresh();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    setErr(null);
    try {
      // Turso auth mode: our own OAuth flow with the same Google client —
      // users see the identical consent screen; Supabase is not in the loop.
      //
      // Asks the SERVER rather than reading NEXT_PUBLIC_EMPIRE_AUTH_BACKEND.
      // That mirror was a fourth flag nobody would remember to set: with
      // EMPIRE_AUTH_BACKEND=turso but the NEXT_PUBLIC_ copy unset, password
      // login went to Turso while Google silently kept going to Supabase —
      // half-migrated auth that looks fine until an OAuth user signs in.
      if ((await authMode()) === "turso") {
        const start = new URL("/api/auth/google/start", window.location.origin);
        // Return to the authenticated invite landing page, not the generic
        // welcome screen. The landing page performs the same email-pinned,
        // tenant-scoped redemption as password login.
        start.searchParams.set(
          "next",
          inviteToken ? `/invite/${encodeURIComponent(inviteToken)}` : next,
        );
        window.location.assign(start.toString());
        return;
      }
      const supa = getBrowserSupabase();
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", next);
      if (inviteToken) callback.searchParams.set("invite", inviteToken);
      const { error } = await supa.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: callback.toString(),
        },
      });
      if (error) setErr(error.message);
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "OAuth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <Link href="/" className="inline-flex items-center gap-3 mb-4 group">
            <OasisLogo size={44} priority className="group-hover:ring-accent/70 transition-all" />
            <div className="text-fg font-bold tracking-tight text-lg">OASIS AI</div>
          </Link>
          <h1 className="text-2xl font-bold text-fg">Sign in to Command Center</h1>
          <p className="text-fg-muted text-sm mt-2">
            The operating system for your AI agents.
          </p>
        </div>

        {isFreshFromSignup && !errHint && (
          <div className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-fg">
            <div className="font-semibold text-accent">Almost there.</div>
            <div className="text-fg-muted text-xs mt-1 leading-relaxed">
              Your account is ready. Sign in below with the password you just
              created and you&apos;ll land on your Command Center.
            </div>
          </div>
        )}

        {errHint && (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-fg">
            <div className="font-semibold text-amber-300">Couldn&apos;t complete that invite</div>
            <div className="text-fg-muted text-xs mt-1 leading-relaxed">{errHint}</div>
          </div>
        )}

        <div className="bg-bg-panel border border-bg-border rounded-xl p-6 shadow-card">
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="text-xs uppercase tracking-wider font-bold text-fg-muted">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="mt-1.5 w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-fg focus:border-accent focus:outline-none"
                placeholder="you@oasisai.work"
                autoComplete="email"
              />
            </div>
            <div>
              <div className="flex justify-between items-center">
                <label className="text-xs uppercase tracking-wider font-bold text-fg-muted">
                  Password
                </label>
                <Link
                  href={(() => {
                    const query = new URLSearchParams();
                    if (inviteToken) query.set("invite", inviteToken);
                    if (email.trim()) query.set("email", email.trim());
                    return query.size ? `/forgot-password?${query.toString()}` : "/forgot-password";
                  })()}
                  className="text-xs text-accent hover:underline"
                >
                  Forgot?
                </Link>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="mt-1.5 w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-fg focus:border-accent focus:outline-none"
                autoComplete="current-password"
              />
            </div>
            {err && (
              <div className="text-sm text-status-hot bg-status-hot/10 border border-status-hot/30 rounded-md px-3 py-2">
                {err}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-accent text-bg font-bold py-2.5 rounded-md hover:bg-accent-muted transition-colors disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-bg-border" />
            <span className="text-xs text-fg-dim uppercase tracking-wider">or</span>
            <div className="h-px flex-1 bg-bg-border" />
          </div>

          <button
            onClick={onGoogle}
            disabled={busy}
            className="w-full bg-bg-elev border border-bg-border text-fg font-medium py-2.5 rounded-md hover:bg-bg-hover transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18a10.97 10.97 0 0 0 0 9.86l3.66-2.84Z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
              />
            </svg>
            Continue with Google
          </button>
        </div>

        <p className="text-center text-sm text-fg-muted mt-6">
          New to OASIS?{" "}
          <Link
            href={inviteToken ? `/signup?invite=${encodeURIComponent(inviteToken)}` : "/signup"}
            className="text-accent hover:underline font-medium"
          >
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
