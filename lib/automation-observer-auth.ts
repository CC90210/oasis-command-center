import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Independent observer only: both secrets are required on every deployment. */
export function checkAutomationObserverAuth(req: NextRequest): NextResponse | null {
  const bearer = process.env.CRON_SECRET;
  const attestation = process.env.AUTOMATION_OBSERVER_ATTEST_SECRET;
  if (!bearer || !attestation) return NextResponse.json({ error: "observer_auth_not_configured" }, { status: 500 });
  const first = matches(req.headers.get("authorization") || "", `Bearer ${bearer}`);
  const second = matches(req.headers.get("x-oasis-observer-attest") || "", attestation);
  return first && second ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
