"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { AuthRedirectGuard } from "@/components/AuthRedirectGuard";

export default function SignupPage() {
  const router = useRouter();
  const params = useSearchParams();
  const brandHint = (params.get("brand") || "").trim();
  const inviteToken = (params.get("invite") || "").trim();
  const emailHint = (params.get("email") || "").trim();
  // Workspace name comes from the /invite/[token] landing page's preview
  // RPC. It's a display-only hint so the invitee sees "Join Sun Biz
  // Funding" instead of the generic OASIS AI brand. Sanitized to a
  // reasonable length to avoid an attacker forging a wildly long
  // workspace label via the URL.
  const workspaceHint = (params.get("workspace") || "").trim().slice(0, 80);
  const [email, setEmail] = useState(emailHint);
  const [fullName, setFullName] = useState("");
  const [brand, setBrand] = useState(brandHint);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      // Client-side password floor. Supabase will also reject weak
      // passwords server-side but its error copy is generic
      // ("Password should be at least 6 characters"). Catching it here
      // gives the operator a specific, actionable message before the
      // round-trip — and prevents the auto-create-tenant side-effects
      // from firing on a doomed signup.
      const passwordIssue = validatePassword(password);
      if (passwordIssue) {
        setErr(passwordIssue);
        setBusy(false);
        return;
      }

      const supa = getBrowserSupabase();
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", inviteToken ? "/onboarding/welcome" : "/onboarding/wizard");
      if (inviteToken) callback.searchParams.set("invite", inviteToken);
      if (brand || brandHint) callback.searchParams.set("brand", brand || brandHint);
      if (fullName.trim()) callback.searchParams.set("full_name", fullName.trim());

      const { data, error } = await supa.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: callback.toString(),
          data: { full_name: fullName, brand: brand || "OASIS AI" },
        },
      });
      if (error) {
        setErr(error.message);
        return;
      }
      // Branch on invite token. If present, the recipient is joining an
      // existing tenant — redeem instead of provisioning a new tenant.
      // If absent, this is a fresh top-level signup (creates a new tenant).
      if (data.user) {
        if (inviteToken) {
          if (!data.session) {
            // Supabase email-confirmation gate fired. The invitee already
            // proved possession of this email by clicking the personalized
            // invite link to get here, so requiring another email round-trip
            // breaks the onboarding loop. Auto-confirm + redeem server-side,
            // then bounce to /login with the email pre-filled so they sign
            // in with the password they just created.
            const r = await fetch("/api/auth/finalize-invite-signup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                raw_token: inviteToken,
                user_id: data.user.id,
              }),
            });
            const body = (await r.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
              message?: string;
            };
            if (!r.ok || !body.ok) {
              setErr(body.message || body.error || "Invite finalization failed");
              return;
            }
            // Intentionally omit ?invite= from the /login URL — the
            // server-side finalize step above already redeemed the token,
            // so re-passing it would make LoginForm call redeem-invite a
            // second time and fail with "invalid_or_expired". Pass next=
            // so /auth/land routes to the welcome wizard post-signin.
            const loginUrl =
              `/login?email=${encodeURIComponent(email)}` +
              `&fresh=1` +
              `&next=${encodeURIComponent("/onboarding/welcome")}`;
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
          };
          if (!r.ok || !body.ok) {
            setErr(body.message || body.error || "Invite redemption failed");
            return;
          }
          // First-login invitees land on the welcome wizard (Phase C).
          // Returning users (re-redeem of a previously-redeemed token
          // shouldn't happen because the RPC marks redeemed_at, but if
          // they somehow get here, send them home).
          router.push(body.first_login ? "/onboarding/welcome" : "/");
          router.refresh();
          return;
        }

        const r = await fetch("/api/auth/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            full_name: fullName,
            brand: brand || "OASIS AI",
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setErr(body.error || "Provisioning failed");
          return;
        }
      }

      // Fresh-tenant signups land on the industry-template wizard.
      router.push("/onboarding/wizard");
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
      const supa = getBrowserSupabase();
      const oauthBrand = (brand || brandHint || "OASIS AI").trim();
      const oauthName = fullName.trim();
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("signup", "1");
      callback.searchParams.set("next", inviteToken ? "/onboarding/welcome" : "/onboarding/wizard");
      if (inviteToken) callback.searchParams.set("invite", inviteToken);
      if (oauthBrand) callback.searchParams.set("brand", oauthBrand);
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
          form again. SPECIAL CASE: if they arrived with an invite token,
          send them to /invite/<token> instead of "/" so the redemption
          flow still fires. Bouncing them straight to "/" would strand
          them in their original tenant and silently drop the invite —
          Codex caught this 2026-05-24. */}
      <AuthRedirectGuard to={inviteToken ? `/invite/${encodeURIComponent(inviteToken)}` : "/"} />
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <OasisLogo size={44} priority />
            <div className="text-fg font-bold tracking-tight text-lg">OASIS AI</div>
          </div>
          <h1 className="text-2xl font-bold text-fg">
            {inviteToken
              ? workspaceHint
                ? `Join ${workspaceHint}`
                : "Accept your invite"
              : "Create your Command Center"}
          </h1>
          <p className="text-fg-muted text-sm mt-2">
            {inviteToken
              ? "Set up your personal account. You'll join the workspace right after."
              : "Your isolated workspace. Multi-agent. Profile-driven."}
          </p>
        </div>

        {inviteToken && (
          <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-[12px] text-fg-muted">
            ✓ Invite detected
            {workspaceHint ? ` for ${workspaceHint}` : ""} —
            you&apos;ll be added to the workspace automatically after signup.
          </div>
        )}

        <div className="bg-bg-panel border border-bg-border rounded-xl p-6 shadow-card">
          <form onSubmit={onSubmit} className="space-y-3">
            <Field label="Full name" value={fullName} onChange={setFullName} required autoComplete="name" />
            <Field label="Email" type="email" value={email} onChange={setEmail} required autoComplete="email" />
            <Field
              label="Brand or company name"
              value={brand}
              onChange={setBrand}
              placeholder="OASIS AI"
              autoComplete="organization"
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              required
              autoComplete="new-password"
              hint="At least 8 characters with a letter and a number."
            />

            {err && (
              <div className="text-sm text-status-hot bg-status-hot/10 border border-status-hot/30 rounded-md px-3 py-2">
                {err}
              </div>
            )}
            {info && (
              <div className="text-sm text-accent bg-accent/10 border border-accent/30 rounded-md px-3 py-2">
                {info}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-accent text-bg font-bold py-2.5 rounded-md hover:bg-accent-muted transition-colors disabled:opacity-50"
            >
              {busy ? "Creating account…" : "Create account"}
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
            className="w-full bg-bg-elev border border-bg-border text-fg font-medium py-2.5 rounded-md hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            Sign up with Google
          </button>
        </div>

        <p className="text-center text-sm text-fg-muted mt-6">
          Already have an account?{" "}
          <Link
            href={inviteToken ? `/login?invite=${encodeURIComponent(inviteToken)}` : "/login"}
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

/**
 * Client-side password floor. Mirrors Supabase's server-side minimum of
 * 8 characters but adds a "must contain at least one letter and one
 * number" rule so we catch the dictionary-word case before the network
 * round-trip. Returns a human-readable error string when the password
 * fails, or null when it passes.
 */
function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) {
    return "Password must be at least 8 characters.";
  }
  const hasLetter = /[A-Za-z]/.test(pwd);
  const hasDigit = /\d/.test(pwd);
  if (!hasLetter || !hasDigit) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}
