"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { confirmPasswordReset } from "@/lib/auth-client";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { validatePassword, PASSWORD_HINT } from "@/lib/password-validation";

/**
 * Where the password-reset email's link lands. Supabase's reset email
 * sends users here with a recovery token in the URL fragment. We let
 * Supabase parse the fragment via getSession(), then show a form for
 * the new password.
 */
export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const [pwd, setPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // Two link shapes, because two auth backends are live during the migration:
  //   Turso    ?turso_token=<raw>  — an opaque single-use token we POST back
  //   Supabase #access_token=...   — a recovery session the browser client
  //                                  picks up from the URL fragment
  const tursoToken = searchParams.get("turso_token");
  const inviteToken = (searchParams.get("invite") || "").trim();
  const emailHint = (searchParams.get("email") || "").trim();

  useEffect(() => {
    if (tursoToken) {
      // Nothing to establish: the token IS the credential, verified server-side
      // when the new password is submitted.
      setSessionReady(true);
      return;
    }
    const supa = getBrowserSupabase();
    // Force session pickup in case the URL fragment hasn't been parsed yet
    supa.auth.getSession().then(({ data }) => {
      if (data.session) setSessionReady(true);
    });
    const { data: sub } = supa.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setSessionReady(true);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [tursoToken]);

  // Treat any error in the URL search params as a hard fail (Supabase appends ?error=...)
  const urlError = searchParams.get("error_description") || searchParams.get("error");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pwd !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    // Use the same rules as /signup so a reset password is one a user
    // could have signed up with. Previously this only checked length,
    // which let a user reset to a weaker password than signup allowed.
    const issue = validatePassword(pwd);
    if (issue) {
      setErr(issue);
      return;
    }
    setBusy(true);
    try {
      if (tursoToken) {
        const res = await confirmPasswordReset(tursoToken, pwd);
        if (!res.ok) {
          setErr(res.error ?? "could not reset password");
          return;
        }
      } else {
        const supa = getBrowserSupabase();
        const { error } = await supa.auth.updateUser({ password: pwd });
        if (error) {
          setErr(error.message);
          return;
        }
      }
      if (inviteToken) {
        const redeem = await fetch("/api/auth/redeem-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_token: inviteToken }),
        });
        const body = (await redeem.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          message?: string;
          tenant_slug?: string | null;
        };
        setDone(true);
        if (!redeem.ok || !body.ok) {
          setErr(
            "Your password was updated, but the workspace invite could not be completed. " +
              "Open the invite again while signed in, or ask your admin for a fresh link."
          );
          return;
        }
        const slug = body.tenant_slug?.trim();
        setTimeout(
          () => window.location.assign(slug ? `/t/${slug}` : "/auth/land?next=%2F"),
          900,
        );
        return;
      }

      setDone(true);
      // Both recovery backends establish an authenticated session after a
      // successful password change, so tenant-aware landing is deterministic.
      setTimeout(() => window.location.assign("/auth/land?next=%2F"), 900);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <OasisLogo size={44} priority />
            <div className="text-fg font-bold tracking-tight text-lg">OASIS AI</div>
          </div>
          <h1 className="text-2xl font-bold text-fg">Set a new password</h1>
          <p className="text-fg-muted text-sm mt-2">
            One-time link from your inbox got you here. Pick something memorable.
          </p>
        </div>

        <div className="bg-bg-panel border border-bg-border rounded-xl p-6 shadow-card">
          {urlError ? (
            <div className="text-sm text-status-hot bg-status-hot/10 border border-status-hot/30 rounded-md px-3 py-3">
              <div className="font-bold mb-1">Reset link failed</div>
              <div className="text-fg-muted">{urlError}</div>
              <Link
                href="/forgot-password"
                className="text-accent hover:underline mt-2 inline-block"
              >
                Request a new link →
              </Link>
            </div>
          ) : done ? (
            <div className="text-sm text-status-engaged bg-status-engaged/10 border border-status-engaged/30 rounded-md px-3 py-3">
              {err ? (
                <>
                  <div className="font-semibold text-fg">Password updated.</div>
                  <div className="mt-1 text-xs text-fg-muted">{err}</div>
                  {inviteToken && (
                    <Link
                      href={`/invite/${encodeURIComponent(inviteToken)}`}
                      className="mt-2 inline-block font-semibold text-accent hover:underline"
                    >
                      Continue with invite →
                    </Link>
                  )}
                </>
              ) : inviteToken ? (
                "Password updated. Joining your workspace…"
              ) : (
                "Password updated. Signing you in…"
              )}
            </div>
          ) : !sessionReady ? (
            <div className="text-sm text-fg-muted text-center py-3">
              Verifying reset link…
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wider font-bold text-fg-muted">
                  New password
                </label>
                <input
                  type="password"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  required
                  className="mt-1.5 w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-fg focus:border-accent focus:outline-none"
                  autoComplete="new-password"
                  autoFocus
                />
                <div className="text-xs text-fg-dim mt-1">{PASSWORD_HINT}</div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wider font-bold text-fg-muted">
                  Confirm
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  className="mt-1.5 w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-fg focus:border-accent focus:outline-none"
                  autoComplete="new-password"
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
                {busy ? "Updating…" : tursoToken ? "Set new password" : "Set password & sign in"}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-sm text-fg-muted mt-6">
          <Link
            href={(() => {
              const query = new URLSearchParams();
              if (inviteToken) query.set("invite", inviteToken);
              if (emailHint) query.set("email", emailHint);
              return query.size ? `/login?${query.toString()}` : "/login";
            })()}
            className="text-accent hover:underline font-medium"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
