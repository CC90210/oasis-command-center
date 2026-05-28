"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
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
        };
        if (!r.ok || !body.ok) {
          // Soft-fail when the invite is already redeemed — this happens
          // in two valid flows: (a) the new finalize-invite-signup endpoint
          // redeems it server-side before the user reaches /login, (b) the
          // user retried sign-in after a successful initial redeem. In both
          // cases the user already has the tenant assignment, so we route
          // them through /auth/land which resolves the right destination
          // based on user_profile state rather than surfacing a confusing
          // "Invite redemption failed" wall.
          const reason = (body.message || body.error || "").toLowerCase();
          const alreadyRedeemed =
            reason.includes("invalid_or_expired") ||
            reason.includes("already") ||
            reason.includes("redeemed");
          if (!alreadyRedeemed) {
            setErr(body.message || body.error || "Invite redemption failed");
            return;
          }
          router.push(`/auth/land?next=${encodeURIComponent("/onboarding/welcome")}`);
          router.refresh();
          return;
        }
        router.push(body.first_login ? "/onboarding/welcome" : "/");
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
                  href="/forgot-password"
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
