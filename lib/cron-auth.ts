/**
 * A5: Cron auth gate — require BOTH a matching CRON_SECRET bearer token AND
 * Vercel's `x-vercel-cron: 1` header. Either alone is insufficient. Vercel's
 * cron infrastructure sends both automatically when the route is wired in
 * vercel.json crons. An external caller who learns CRON_SECRET still cannot
 * forge `x-vercel-cron: 1` from outside Vercel's edge — the platform strips
 * client-supplied versions of that header on the way in.
 *
 * Returns null on success; otherwise a 401/500 NextResponse the route can
 * return directly.
 */

import { NextResponse, type NextRequest } from "next/server";

/** Constant-time string compare — auth material must not leak via timing. */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkCronAuth(req: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Misconfiguration is a hard failure — refuse to run rather than
    // silently bypassing auth.
    return NextResponse.json(
      { error: "cron_not_configured", detail: "CRON_SECRET is not set." },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEq(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Second leg — one of:
  //  - x-vercel-cron: 1  (platform-injected, unforgeable from outside Vercel;
  //    kept until Vercel retirement)
  //  - x-oasis-cron-attest matching CRON_ATTEST_SECRET (the oasis-cc-cron
  //    companion Worker's leg — two independent secrets replace the
  //    secret+platform pair on Cloudflare; see workers/oasis-cc-cron and
  //    Business-Empire-Agent brain/WAVE3_OASIS_CC_RUNBOOK.md). The attest path
  //    activates only when the env secret exists, so nothing changes on
  //    deployments that haven't minted it.
  //  - CRON_ALLOW_LOCAL=1 local-dev escape hatch (unchanged).
  const allowLocal = process.env.CRON_ALLOW_LOCAL === "1";
  const vercelCron = req.headers.get("x-vercel-cron") === "1";
  const attestExpected = process.env.CRON_ATTEST_SECRET;
  const attestGiven = req.headers.get("x-oasis-cron-attest") || "";
  const attestOk = Boolean(attestExpected) && timingSafeEq(attestGiven, attestExpected as string);
  if (!vercelCron && !attestOk && !allowLocal) {
    return NextResponse.json(
      { error: "unauthorized", detail: "missing_cron_platform_proof" },
      { status: 401 }
    );
  }
  return null;
}
