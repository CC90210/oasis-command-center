/**
 * Browser-side auth that works on EITHER backend.
 *
 * The dashboard is mid-migration: Supabase Auth is still live and is the
 * rollback path, so every one of these tries the Turso route first and falls
 * back to Supabase when Turso mode is off. The Turso routes 404 when
 * EMPIRE_AUTH_BACKEND is unset, which is the signal to fall back — that is why
 * the checks below are on the STATUS, not on a client-side env var (browsers
 * cannot see server-only env).
 *
 * Delete the Supabase halves once the subscription is actually cancelled, not
 * before.
 */
import { getBrowserSupabase } from "./supabase-browser";

export type AuthUser = { id: string; email: string | null };

/** True when the server is running Turso auth. Cached per page load. */
let modeCache: "turso" | "supabase" | null = null;

export async function authMode(): Promise<"turso" | "supabase"> {
    if (modeCache) return modeCache;
    try {
        const r = await fetch("/api/auth/turso-me", { cache: "no-store" });
        if (r.ok) {
            const j = await r.json();
            modeCache = j?.mode === "turso" ? "turso" : "supabase";
            return modeCache;
        }
    } catch {
        /* fall through */
    }
    modeCache = "supabase";
    return modeCache;
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
        // Deliberately uniform: this endpoint always 200s so it cannot be used
        // to discover which addresses have accounts.
        return r.ok ? { ok: true } : { ok: false, error: "could not send reset email" };
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
