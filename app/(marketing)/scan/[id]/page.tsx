import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ScanApp } from "@/components/scan/ScanApp";
import { resolveConsentIdentity } from "@/lib/consent/ledger-identity";
import { AUDIT_FUNNEL, BOOKING_URL } from "@/lib/marketing/routes";
import { proofCounts } from "@/lib/site-scan/proof";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scan's permalink: the same app, resumed on this scan. Private by obscurity only, so never indexed. */
export const metadata: Metadata = {
  title: "Your free AI scan",
  robots: { index: false, follow: false },
};

export default async function ScanPermalink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const consentIdentity = resolveConsentIdentity({ tenantSlug: AUDIT_FUNNEL.tenantSlug }).identity;
  const proof = await proofCounts();
  return (
    <section className="m-edge relative overflow-hidden">
      <div className="mx-auto w-full max-w-6xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
        <ScanApp initialScanId={id} consentIdentity={consentIdentity} bookingUrl={BOOKING_URL || null} proof={proof} />
      </div>
    </section>
  );
}
