/**
 * POST /api/auth/signout — clears the Supabase session cookie + redirects.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const url = process.env.BRAVO_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const res = NextResponse.redirect(new URL("/login", req.url), { status: 303 });

  // Best-effort. Once the Supabase project is cancelled these env vars go away,
  // and the old `!` assertions would make createServerClient throw — turning
  // "sign out" into a 500 that traps the user in a session they asked to end.
  // Clearing the local cookies below is what actually signs them out.
  if (url && anon) {
    try {
      const supa = createServerClient(url, anon, {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },
          setAll(toSet) {
            toSet.forEach(({ name, value, options }) =>
              res.cookies.set({ name, value, ...options })
            );
          },
        },
      });
      await supa.auth.signOut();
    } catch (e) {
      console.error("[signout] supabase signOut failed (continuing):", e);
    }
  }
  // Clear the Turso session cookie too — unconditionally; a cookie from a
  // previous auth mode must never survive a signout. (Self-review catch:
  // without this, Turso-mode users could not log out.)
  res.cookies.set({ name: "oasis_session", value: "", path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  return POST(req);
}
