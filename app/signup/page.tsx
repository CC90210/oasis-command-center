"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { authMode } from "@/lib/auth-client";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { AuthRedirectGuard } from "@/components/AuthRedirectGuard";
import { validatePassword, PASSWORD_HINT } from "@/lib/password-validation";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { inviteRedeemFailure, inviteRedeemMessage } from "@/lib/invite-redeem-errors";

type RedeemBody = { ok?: boolean; message?: string; error?: string; tenant_slug?: string | null };

/**
 * /signup — invite-only (P0-8, 2026-09-28).
 *
 * The open "Create your Command Center" form is gone: 47 of 49 tenants were
 * self-signups nobody provisioned. Without an `?invite=` token this page says
 * OASIS OS is invite-only and points at the qualification funnel; the account
 * form renders only for someone holding an invite, and /api/auth/turso-signup
 * refuses on the server without one either way. The form never creates a
 * workspace — the invitee joins the inviting tenant through redeem-invite.
 */
export default function SignupPage() {
  const params = useSearchParams();
  const inviteToken = (params.get("invite") || "").trim();
  if (!inviteToken) return <InviteOnly />;
  return (
    <InviteSignup
      inviteToken={inviteToken}
      emailHint={(params.get("email") || "").trim()}
      // Workspace name comes from the /invite/[token] landing page's preview
      // RPC. It's a display-only hint so the invitee sees "Join <workspace>"
      // instead of the generic OASIS AI brand. Sanitized to a reasonable
      // length to avoid an attacker forging a wildly long workspace label via
      // the URL.
      workspaceHint={(params.get("workspace") || "").trim().slice(0, 80)}
    />
  );
}

function InviteOnly() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6 py-12">
      <AuthRedirectGuard to="/" />
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <OasisLogo size={44} priority />
            <div className="text-fg font-bold tracking-tight text-lg">OASIS AI</div>
          </div>
          <h1 className="text-2xl font-bold text-fg">OASIS OS is invite-only</h1>
          <p className="text-fg-muted text-sm mt-2">
            Every workspace is set up with its owner on a call. Book one and we&apos;ll email
            your invite once your workspace is ready.
          </p>
        </div>

        <div className="bg-bg-panel border border-bg-border rounded-xl p-6 shadow-card space-y-4">
          <Link
            href={AUDIT_FUNNEL.path}
            className="block w-full bg-accent text-bg font-bold py-2.5 rounded-md text-center hover:bg-accent-muted transition-colors"
          >
            Book a call
          </Link>
          <p className="text-xs leading-relaxed text-fg-dim">
            Joining a teammate&apos;s workspace? Open the invite link in the email they sent
            you. It brings you back here with your account form.
          </p>
        </div>

        <p className="text-center text-sm text-fg-muted mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-accent hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function InviteSignup({
  inviteToken,
  emailHint,
  workspaceHint,
}: {
  inviteToken: string;
  emailHint: string;
  workspaceHint: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(emailHint);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [accountExists, setAccountExists] = useState(false);
  // Set once the account exists but joining the workspace failed in a way a
  // retry can fix: the invite is still unclaimed, so "Try again" redeems it
  // with the session the account creation already gave us.
  const [joinRetry, setJoinRetry] = useState(false);
  // null until the server says which auth backend runs. Google signup exists
  // only on the legacy backend, so the button stays hidden until we know.
  const [googleSignup, setGoogleSignup] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    authMode()
      .then((mode) => {
        if (live) setGoogleSignup(mode !== "turso");
      })
      .catch((error: unknown) => {
        console.error("[signup] auth backend check failed; hiding Google signup", error);
        if (live) setGoogleSignup(false);
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Join the workspace with the session we hold. On success, open the app:
   * "/" resolves the workspace from the session, and the onboarding gate sends
   * an owner whose workspace is not set up yet to the setup wizard. On failure,
   * show the sentence for the code (never the code) and offer a retry when the
   * invite is still valid.
   */
  async function joinWorkspace(): Promise<void> {
    const rr = await fetch("/api/auth/redeem-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_token: inviteToken }),
    });
    const rb = (await rr.json().catch(() => ({}))) as RedeemBody;
    if (!rr.ok || !rb.ok) {
      setErr(inviteRedeemMessage(rb));
      setJoinRetry(inviteRedeemFailure(rb.error).retryable);
      return;
    }
    setJoinRetry(false);
    // Full-page assign: the session is an httpOnly cookie and server
    // components must re-render with it.
    window.location.assign("/");
  }

  async function onRetryJoin() {
    setBusy(true);
    setErr(null);
    try {
      await joinWorkspace();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? "We could not reach the server. Check your connection and try again." : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    setAccountExists(false);
    try {
      // Client-side password floor. Supabase will also reject weak
      // passwords server-side but its error copy is generic
      // ("Password should be at least 6 characters"). Catching it here
      // gives the operator a specific, actionable message before the
      // round-trip.
      const passwordIssue = validatePassword(password);
      if (passwordIssue) {
        setErr(passwordIssue);
        setBusy(false);
        return;
      }

      // Turso auth mode: create the account server-side (the route checks the
      // invite is active and pinned to this email), then redeem the invite with
      // the session we just received to join the inviting workspace.
      if ((await authMode()) === "turso") {
        const r = await fetch("/api/auth/turso-signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            full_name: fullName.trim(),
            invite_token: inviteToken,
          }),
        });
        const b = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          code?: string;
          error?: string;
        };
        if (!r.ok || !b.ok) {
          if (r.status === 409 && b.code === "account_exists") {
            setAccountExists(true);
            setErr(
              "This email already has an OASIS account. Keep that account and authenticate it to accept this workspace invite."
            );
          } else {
            setErr(b.error || "Could not create your account.");
          }
          return;
        }
        await joinWorkspace();
        return;
      }

      const supa = getBrowserSupabase();
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", "/onboarding/welcome");
      callback.searchParams.set("invite", inviteToken);
      if (fullName.trim()) callback.searchParams.set("full_name", fullName.trim());

      const { data, error } = await supa.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: callback.toString(),
          data: { full_name: fullName },
        },
      });
      if (error) {
        setErr(error.message);
        return;
      }
      if (!data.user) {
        setErr("Could not create your account.");
        return;
      }
      // The recipient is joining an existing tenant — redeem the invite.
      // There is no fresh-tenant branch any more (P0-8).
      if (!data.session) {
        // Supabase email-confirmation gate fired. The invitee already
        // proved possession of this email by clicking the personalized
        // invite link to get here, so requiring another email round-trip
        // breaks the onboarding loop. Auto-confirm + redeem server-side,
        // then bounce to /login with the email pre-filled so they sign
        // in with the password they just created.
        //
        // RETRY: a transient failure here used to ORPHAN the auth.users
        // row Supabase just created — invite never redeemed, profile
        // never made, user stuck on "unauthorized" forever (caught
        // 2026-06-01 when Emily hit this). The finalize route is
        // fully idempotent (email_confirm=true is a no-op on already-
        // confirmed users; redeemInvite has an explicit already-redeemed
        // branch returning ok=true), so retrying on network / 5xx
        // errors is safe. Two attempts with 1s backoff covers the
        // common transient-blip class without delaying the happy path.
        let body: {
          ok?: boolean;
          error?: string;
          message?: string;
          tenant_slug?: string | null;
        } = {};
        let lastStatus = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
          try {
            const r = await fetch("/api/auth/finalize-invite-signup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                raw_token: inviteToken,
                user_id: data.user.id,
              }),
            });
            lastStatus = r.status;
            body = (await r.json().catch(() => ({}))) as typeof body;
            if (r.ok && body.ok) break;
          } catch {
            lastStatus = 0;
            body = {};
          }
        }
        if (!body.ok) {
          // Surface a clear, actionable message so the invitee knows
          // they aren't simply locked out — their account exists but
          // the workspace link didn't finish. Support can finish it
          // server-side (the repair path used for Emily).
          setErr(
            (body.error || body.message
              ? inviteRedeemMessage(body)
              : `We could not reach the server (HTTP ${lastStatus || "?"}).`) +
              " Your account was created but is not linked to the workspace yet. Reach out to your workspace admin and they can finish the setup in one step."
          );
          return;
        }
        // Intentionally omit ?invite= from the /login URL — the
        // server-side finalize step above already redeemed the token,
        // so re-passing it would make LoginForm call redeem-invite a
        // second time and fail with "invalid_or_expired". Pass next=
        // pointing directly at the tenant workspace (e.g. /t/sun)
        // when finalize gave us a tenant_slug, so the invitee skips
        // the redundant new-tenant wizard entirely (2026-05-29 fix).
        // Fall back to "/" when no slug — /auth/land + the welcome
        // page's own redirect catch the legacy path.
        const finalSlug = body.tenant_slug?.trim();
        const nextPath = finalSlug ? `/t/${finalSlug}` : "/";
        const loginUrl =
          `/login?email=${encodeURIComponent(email)}` +
          `&fresh=1` +
          `&next=${encodeURIComponent(nextPath)}`;
        router.push(loginUrl);
        router.refresh();
        return;
      }
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
        setErr(inviteRedeemMessage(body));
        return;
      }
      // Invitees skip the new-tenant wizard and land directly in
      // their tenant workspace (2026-05-29 fix). Falls back to "/"
      // when no slug was resolvable — the welcome page's own
      // redirect catches the legacy path.
      const slug = body.tenant_slug?.trim();
      router.push(slug ? `/t/${slug}` : "/");
      router.refresh();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : "Sign up failed");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    setErr(null);
    try {
      // Turso auth mode: new-account creation is a deliberate provisioning
      // flow, not an OAuth side effect — Google SIGNUP is disabled until the
      // Turso signup path ships. Existing Google users sign in at /login.
      // Gate reads the SERVER's answer, not NEXT_PUBLIC_EMPIRE_AUTH_BACKEND —
      // that mirror is a separate flag, and leaving it unset would send signups
      // to Supabase while the rest of auth ran on Turso.
      if ((await authMode()) === "turso") {
        setErr("Google signup is temporarily unavailable — existing users can sign in at /login.");
        setBusy(false);
        return;
      }
      const supa = getBrowserSupabase();
      const oauthName = fullName.trim();
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("signup", "1");
      callback.searchParams.set("next", "/onboarding/welcome");
      callback.searchParams.set("invite", inviteToken);
      if (oauthName) callback.searchParams.set("full_name", oauthName);
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
    <div className="min-h-screen bg-bg flex items-center justify-center px-6 py-12">
      {/* Same defensive guard as /login and /welcome — an already-authed
          user landing on /signup (back button after success, accidental
          re-visit) should be bounced into the app, not shown the signup
          form again. They arrived with an invite token, so send them to
          /invite/<token> instead of "/" so the redemption flow still fires.
          Bouncing them straight to "/" would strand them in their original
          tenant and silently drop the invite — Codex caught this 2026-05-24. */}
      <AuthRedirectGuard to={`/invite/${encodeURIComponent(inviteToken)}`} />
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <OasisLogo size={44} priority />
            <div className="text-fg font-bold tracking-tight text-lg">OASIS AI</div>
          </div>
          <h1 className="text-2xl font-bold text-fg">
            {workspaceHint ? `Join ${workspaceHint}` : "Accept your invite"}
          </h1>
          <p className="text-fg-muted text-sm mt-2">
            Set up your personal account. You&apos;ll join the workspace right after.
          </p>
        </div>

        <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-[12px] text-fg-muted">
          ✓ Invite detected
          {workspaceHint ? ` for ${workspaceHint}` : ""} —
          you&apos;ll be added to the workspace automatically after signup.
        </div>

        <div className="bg-bg-panel border border-bg-border rounded-xl p-6 shadow-card">
          <form onSubmit={onSubmit} className="space-y-3">
            <Field label="Full name" value={fullName} onChange={setFullName} required autoComplete="name" />
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={(value) => {
                setEmail(value);
                setAccountExists(false);
              }}
              required
              autoComplete="email"
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              required
              autoComplete="new-password"
              hint={PASSWORD_HINT}
            />

            {err && (
              <div className="text-sm text-status-hot bg-status-hot/10 border border-status-hot/30 rounded-md px-3 py-2">
                {err}
              </div>
            )}
            {joinRetry && (
              <button
                type="button"
                onClick={onRetryJoin}
                disabled={busy}
                className="w-full rounded-md border border-accent/50 bg-accent/10 py-2 text-sm font-bold text-fg hover:bg-accent/20 disabled:opacity-50"
              >
                {busy ? "Joining…" : "Try joining again"}
              </button>
            )}
            {accountExists && (
              <div className="rounded-lg border border-accent/35 bg-accent/5 p-3 space-y-2.5">
                <div className="text-xs font-semibold text-fg">
                  Your account is safe — it does not need to be deleted or recreated.
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Link
                    href={(() => {
                      const query = new URLSearchParams();
                      if (inviteToken) query.set("invite", inviteToken);
                      if (email.trim()) query.set("email", email.trim());
                      return `/login?${query.toString()}`;
                    })()}
                    className="rounded-md bg-accent px-3 py-2 text-center text-xs font-bold text-bg hover:bg-accent-muted"
                  >
                    Sign in &amp; accept
                  </Link>
                  <Link
                    href={(() => {
                      const query = new URLSearchParams();
                      if (inviteToken) query.set("invite", inviteToken);
                      if (email.trim()) query.set("email", email.trim());
                      if (workspaceHint) query.set("workspace", workspaceHint);
                      return `/forgot-password?${query.toString()}`;
                    })()}
                    className="rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-center text-xs font-bold text-fg hover:border-accent/60"
                  >
                    Reset password
                  </Link>
                </div>
              </div>
            )}
            {info && (
              <div className="text-sm text-accent bg-accent/10 border border-accent/30 rounded-md px-3 py-2">
                {info}
              </div>
            )}

            {/* Consent must be visible BEFORE the action that forms the
                contract — a link buried in a footer is not assent. Covers both
                the email/password submit below and the Google button, which is
                why the copy says "or continuing". */}
            <p className="text-xs leading-relaxed text-fg-dim">
              By creating an account or continuing, you agree to our{" "}
              <a
                href="/terms"
                className="text-fg underline underline-offset-2 hover:text-accent"
              >
                Terms of Service
              </a>{" "}
              (including Binding Arbitration) and{" "}
              <a
                href="/privacy"
                className="text-fg underline underline-offset-2 hover:text-accent"
              >
                Privacy Policy
              </a>
              . This product uses AI and large language models to process your
              data.
            </p>

            {!joinRetry && (
              <button
                type="submit"
                disabled={busy}
                className="w-full bg-accent text-bg font-bold py-2.5 rounded-md hover:bg-accent-muted transition-colors disabled:opacity-50"
              >
                {busy ? "Creating account…" : "Create account"}
              </button>
            )}
          </form>

          {/* Google signup exists only on the legacy auth backend. Under Turso
              auth it could only answer "temporarily unavailable", so the
              button is not drawn at all (2026-09-30 audit: a dead button). */}
          {googleSignup === true && (
            <>
              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-bg-border" />
                <span className="text-xs text-fg-dim">or</span>
                <div className="h-px flex-1 bg-bg-border" />
              </div>

              <button
                onClick={onGoogle}
                disabled={busy}
                className="w-full bg-bg-elev border border-bg-border text-fg font-medium py-2.5 rounded-md hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                Sign up with Google
              </button>
            </>
          )}
        </div>

        <p className="text-center text-sm text-fg-muted mt-6">
          Already have an account?{" "}
          <Link
            href={(() => {
              if (!inviteToken && !email.trim()) return "/login";
              const query = new URLSearchParams();
              if (inviteToken) query.set("invite", inviteToken);
              if (email.trim()) query.set("email", email.trim());
              return `/login?${query.toString()}`;
            })()}
            className="text-accent hover:underline font-medium"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  type = "text",
  value,
  onChange,
  required,
  placeholder,
  autoComplete,
  hint,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider font-bold text-fg-muted">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="mt-1.5 w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-fg focus:border-accent focus:outline-none"
      />
      {hint && <div className="text-xs text-fg-dim mt-1">{hint}</div>}
    </div>
  );
}

