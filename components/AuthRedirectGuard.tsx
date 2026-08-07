"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser } from "@/lib/auth-client";

/**
 * AuthRedirectGuard — defensive client-side bounce for pages that are
 * meant for SIGNED-OUT visitors only (the marketing landing, the
 * sign-in page in some flows, etc.).
 *
 * Background: Supabase SSR cookies can be a tick behind the JS auth
 * client right after sign-in. A user who just authenticated may briefly
 * SSR-render as anonymous on the very next navigation, which sends them
 * to /welcome (the marketing landing) instead of /today (the dashboard).
 * CC hit this 2026-05-24 and reported it as "the sign-in keeps dumping
 * me back at the landing page."
 *
 * The fix is layered: server-side `getSessionUser()` already redirects
 * authed users away from /welcome. This guard catches the residual race
 * where the SSR check ran before the cookie was visible. It re-checks
 * the JS client (which reads localStorage + document.cookie directly)
 * on mount and bounces authed users to `to`.
 *
 * Intentionally cheap — single getUser() call, no listeners. We rely on
 * Next router.replace so the back button doesn't return to /welcome.
 */
export function AuthRedirectGuard({ to = "/" }: { to?: string }) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Asks the server under Turso auth (the session cookie is httpOnly, so
        // the browser cannot inspect it), Supabase otherwise.
        const user = await getCurrentUser();
        if (cancelled) return;
        if (user) router.replace(to);
      } catch {
        // Network glitch / cold-start — leave the landing visible. The
        // user can still click Sign in manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, to]);
  return null;
}
