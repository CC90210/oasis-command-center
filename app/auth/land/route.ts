import { NextResponse, type NextRequest } from "next/server";
import { DEMO_CLIENT_PROFILE_COOKIE } from "@/lib/client-profiles";
import { resolvePostLoginRedirect } from "@/lib/auth-routing";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    const login = new URL("/login", req.url);
    const requestedNext = req.nextUrl.searchParams.get("next");
    if (requestedNext) login.searchParams.set("next", requestedNext);
    return NextResponse.redirect(login);
  }

  const requestedNext = req.nextUrl.searchParams.get("next") || "/";
  const path = await resolvePostLoginRedirect({
    db: getServiceSupabase(),
    authUserId: user.id,
    email: user.email,
    requestedNext,
  }).catch(() => "/");

  const res = NextResponse.redirect(new URL(path, req.url));
  res.cookies.set(DEMO_CLIENT_PROFILE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
