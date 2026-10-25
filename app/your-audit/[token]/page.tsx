/**
 * /your-audit/<token> — a client's private Free AI Audit.
 *
 * The token is the client's only credential (lib/ai-audit/link.ts). This page
 * shows the exact audit and proposal CC approved and delivered, drawn by the
 * same component the PDF is printed from. A missing, expired or revoked link
 * gets one neutral page. Never indexed, never cached, no referrer
 * (next.config.js); public in middleware.ts; full-bleed in lib/os/full-bleed.ts.
 */
import type { Metadata } from "next";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import { AuditDocument } from "@/components/ai-audit/doc/AuditDocument";
import { ViewBeacon } from "@/components/ai-audit/doc/ViewBeacon";
import { LinkUnavailable } from "@/components/ai-audit/doc/LinkUnavailable";
import { loadPublicAudit, payUnavailableReason } from "@/lib/ai-audit/public";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Your Free AI Audit | OASIS AI",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const PAY_NOTICES: Readonly<Record<string, string>> = {
  unavailable: "Payment could not be started just now. Please try again in a minute, or reply to our email.",
  busy: "Your checkout is being prepared. Please try again in a moment.",
  closed: "This proposal can no longer be paid here. Reply to our email and we will help.",
};

export default async function YourAuditPage({ params, searchParams }: Props) {
  const { token } = await params;
  const sp = await searchParams;
  if (!tursoConfigured()) return <LinkUnavailable />;
  let data: Awaited<ReturnType<typeof loadPublicAudit>> = null;
  try {
    data = await loadPublicAudit(getTursoClient(), token, new Date());
  } catch (err) {
    console.error("[your-audit] could not load", err instanceof Error ? err.message : err);
    data = null;
  }
  if (!data) return <LinkUnavailable />;
  const payCode = typeof sp.pay === "string" ? sp.pay : "";
  return (
    <div className={offerFontVariables}>
      <AuditDocument
        doc={data.audit.doc}
        proposal={data.proposal.content}
        totals={data.totals}
        mode="web"
        payAction={`/api/your-audit/${encodeURIComponent(token)}/pay`}
        payUnavailable={payUnavailableReason(data, new Date())}
        pdfHref={data.audit.pdf_path ? `/api/your-audit/${encodeURIComponent(token)}/pdf` : null}
        notice={PAY_NOTICES[payCode] ?? null}
      />
      <ViewBeacon token={token} />
    </div>
  );
}
