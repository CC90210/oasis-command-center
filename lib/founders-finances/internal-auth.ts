/**
 * Bearer auth for the CFO agent (Atlas) on /api/internal/finance/*.
 *
 * FINANCE_AGENT_TOKEN, compared with crypto.timingSafeEqual over SHA-256
 * digests (equal length by construction, so the comparison itself cannot
 * leak the token's length). Unset -> 503 for every call: fail closed, never
 * "no token configured means open". Same shape as lib/cron-auth.ts.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export function bearerMatches(header: string | null, expected: string): boolean {
  const given = (header || "").startsWith("Bearer ") ? (header as string).slice(7) : "";
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

export function checkFinanceAgentAuth(req: Request): NextResponse | null {
  const expected = (process.env.FINANCE_AGENT_TOKEN || "").trim();
  if (expected.length < 24) {
    return NextResponse.json(
      { ok: false, error: "finance_agent_not_configured", detail: "FINANCE_AGENT_TOKEN is not set (min 24 chars)." },
      { status: 503 },
    );
  }
  if (!bearerMatches(req.headers.get("authorization"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}
