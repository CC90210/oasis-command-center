/**
 * Browser-side auth with an explicit legacy rollback.
 *
 * Turso is the default. The server reports `supabase_legacy` only when an
 * operator selected that rollback mode deliberately. Network failures,
 * invalid responses, and missing Turso configuration throw; none of them may
 * silently switch the browser to the retired auth provider.
 */
import { getBrowserSupabase } from "./supabase-browser";

export type AuthUser = { id: string; email: string | null };

/** True when the server is running Turso auth. Cached per page load. */
let modeCache: "turso" | "supabase_legacy" | null = null;

export async function authMode(): Promise<"turso" | "supabase_legacy"> {
    if (modeCache) return modeCache;
    try {
        const r = await fetch("/api/auth/turso-me", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            throw new Error(j?.error || `auth backend check failed (${r.status})`);
        }
        if (j?.mode !== "turso" && j?.mode !== "supabase_legacy") {
            throw new Error("auth backend returned an unsupported mode");
        }
        // Narrow into a local first: TS won't narrow a module-level `let`
        // across the assignment, so `return modeCache` would still see `null`.
        const mode: "turso" | "supabase_legacy" = j.mode;
        modeCache = mode;
        return mode;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to resolve the authentication backend: ${message}`);
    }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
    if ((await authMode()) === "turso") {
        const r = await fetch("/api/auth/turso-me", { cache: "no-store" });
        if (!r.ok) return null;
        const j = await r.json();
        return j?.user ?? null;
    }
    const { data } = await getBrowserSupabase().auth.getUser();
    return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
}

export async function signInWithPassword(
    email: string, password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    if ((await authMode()) === "turso") {
        const r = await fetch("/api/auth/turso-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const j = await r.json().catch(() => ({}));
        return r.ok ? { ok: true } : { ok: false, error: j?.error || "sign-in failed" };
    }
    const { error } = await getBrowserSupabase().auth.signInWithPassword({ email, password });
    return error ? { ok: false, error: error.message } : { ok: true };
}

export async function requestPasswordReset(
    email: string, redirectTo: string,
): Promise<{ ok: boolean; error?: string }> {
    if ((await authMode()) === "turso") {
        const r = await fetch("/api/auth/turso-reset-request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
        });
        const j = await r.json().catch(() => ({}));
        // Unauthenticated requests remain uniform. The route returns a specific
        // non-200 error only when a signed-in user requests their own reset.
        return r.ok
            ? { ok: true }
            : { ok: false, error: j?.error || "could not send reset email" };
    }
    const { error } = await getBrowserSupabase().auth.resetPasswordForEmail(
        email, { redirectTo });
    return error ? { ok: false, error: error.message } : { ok: true };
}

/** Redeem a reset link. `token` comes from ?turso_token= on the reset page. */
export async function confirmPasswordReset(
    token: string, password: string,
): Promise<{ ok: boolean; error?: string }> {
    const r = await fetch("/api/auth/turso-reset-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, error: j?.error || "could not reset password" };
}

export async function changePassword(
    currentPassword: string, newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
    if ((await authMode()) === "turso") {
        const r = await fetch("/api/auth/turso-change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        return r.ok ? { ok: true } : { ok: false, error: j?.error || "could not change password" };
    }
    const { error } = await getBrowserSupabase().auth.updateUser({ password: newPassword });
    return error ? { ok: false, error: error.message } : { ok: true };
}
