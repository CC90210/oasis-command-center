/**
 * Chrome for the Founders Portal.
 *
 * WHY THIS LAYOUT EXISTS
 * The command center hosts several portals in one deployment: SunBiz Funding
 * (lending), OASIS AI, and later real estate. They are separate applications
 * that happen to share a shell. Adon, 2026-08-03: "Those are two very separate
 * pieces of software... it's about separation."
 *
 * Everything under /founders is OASIS's OWN tooling — not a tenant of the
 * platform, not something a customer is ever sold. It must not read as one more
 * CRM tab. This wrapper gives it its own header, its own accent, and its own
 * sub-nav so the boundary is obvious the moment you look at the screen. The
 * exception is Finances, which shows its own tab bar instead of the banner
 * (CC, 2026-09-24).
 *
 * THE ACCENT IS DELIBERATE. The multi-tenant CRM uses the neutral platform blue
 * (#3b82f6, tailwind `accent`). The founders portal uses OASIS cyan #1FE3F0 —
 * the real brand colour from brain/brand-assets/oasis-ai/BRAND_SYSTEM.md. So it
 * does not merely look different, it looks MORE like OASIS, while the tenant
 * shells stay brand-neutral platform surfaces.
 *
 * Access is gated per-page via resolveFounder(), not here: a layout cannot
 * notFound() reliably for every child, and a gate that only half-applies is
 * worse than none. Each page calls the gate itself.
 */

import { notFound } from "next/navigation";
import { resolveFounder } from "@/lib/founders/gate";
import { FOUNDERS_PORTAL } from "@/lib/portals/registry";
import { isFinanceOwnerEmail } from "@/lib/founders-finances/access";
import { FoundersPortalBanner } from "@/components/founders/FoundersPortalBanner";

export default async function FoundersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defence in depth. Every page also calls resolveFounder(); this catches a
  // future page that forgets to, so the failure mode of forgetting is a 404
  // rather than an open door.
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <div className="space-y-6">
      {/* Portal banner (wordmark, tagline, section chips). Renders on every
          founders page EXCEPT /founders/finances/**, which starts with its own
          tab bar (see FoundersPortalBanner). The sections are filtered here,
          on the server: the Finances chip only for the two owners — the
          portal gate also admits the marketing hire. */}
      <FoundersPortalBanner
        label={FOUNDERS_PORTAL.label}
        tagline={FOUNDERS_PORTAL.tagline}
        sections={FOUNDERS_PORTAL.sections.filter(
          (s) => s.audience !== "finance_owners" || isFinanceOwnerEmail(founder.email),
        )}
      />

      {children}
    </div>
  );
}
