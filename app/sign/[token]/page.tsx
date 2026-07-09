/**
 * /sign/[token] — the public, unauthenticated signing page.
 *
 * Same shape as app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx: a
 * server component verifies the token BEFORE rendering anything real (here
 * via lib/esign/resolve-signing-session.ts, which also records the
 * 'viewed' side effects), and only on success hands off to a client
 * component for the interactive part (signature pad, consent, submit).
 * Failures render a clean, GENERIC error page — never a per-reason
 * message — matching the API route's no-enumeration contract.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { resolveSigningSession } from "@/lib/esign/resolve-signing-session";
import { SignClient } from "@/components/esign/SignClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Review & Sign",
  robots: { index: false, follow: false },
};

type RouteParams = { token: string };

/** Minimal x-forwarded-for/user-agent read for a server component — same
 *  logic as lib/api-helpers.ts:82 getClientIp, which is typed against
 *  NextRequest rather than the ReadonlyHeaders this page has access to. */
async function resolveIpAndUa(): Promise<{ ip: string; userAgent: string }> {
  const h = await headers();
  const xff = h.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  const ip = first || h.get("x-real-ip") || "unknown";
  const userAgent = h.get("user-agent") || "unknown";
  return { ip, userAgent };
}

export default async function SignPage({ params }: { params: Promise<RouteParams> }) {
  const { token } = await params;
  const { ip, userAgent } = await resolveIpAndUa();
  const resolved = await resolveSigningSession(token, { ip, userAgent });

  if (!resolved.ok) {
    return <LinkUnavailable />;
  }

  return (
    <SignClient
      token={token}
      envelopeTitle={resolved.session.envelope.title}
      message={resolved.session.envelope.message}
      signerName={resolved.session.signer.name}
      consentDisclosureVersion={resolved.session.consentDisclosureVersion}
      sourcePdfBase64={resolved.session.sourcePdfBase64}
    />
  );
}

function LinkUnavailable() {
  return (
    <main className="min-h-screen bg-bg-deep text-fg flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full rounded-2xl border border-bg-border bg-bg-elev/50 p-8 text-center space-y-3">
        <h1 className="text-xl font-bold">This signing link isn&apos;t available</h1>
        <p className="text-sm text-fg-muted leading-relaxed">
          It may have expired, already been used, or the request may have been cancelled. If you
          think this is a mistake, reach out to whoever sent you this link and ask them to resend it.
        </p>
      </div>
    </main>
  );
}
