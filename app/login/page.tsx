import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/supabase-server";
import { LoginForm } from "./LoginForm";
import { AuthRedirectGuard } from "@/components/AuthRedirectGuard";

export const dynamic = "force-dynamic";

/**
 * Self-healing /login: if the caller already has a valid session, bounce
 * them straight to their `?next=` target (or "/"). Catches the case where
 * middleware or some other layer kicked a signed-in user back to /login —
 * happened to CC on a preview deploy where clicking a Quick Action landed
 * on /login despite an active session. Rather than make them re-sign-in,
 * recognize they're already authed and forward them.
 *
 * Auth-state check is server-side so it runs BEFORE the form renders —
 * no flash of the sign-in UI for already-authed users. The
 * AuthRedirectGuard below catches the residual race where the SSR cookie
 * was stale but the browser already has the session — same defensive
 * pattern as /welcome.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
}) {
  const params = (await searchParams) || {};
  const user = await getSessionUser().catch(() => null);
  const next = typeof params.next === "string" && params.next.startsWith("/")
    ? params.next
    : "/";
  if (user) {
    redirect(`/auth/land?next=${encodeURIComponent(next)}`);
  }
  return (
    <>
      <AuthRedirectGuard to={`/auth/land?next=${encodeURIComponent(next)}`} />
      <LoginForm />
    </>
  );
}
