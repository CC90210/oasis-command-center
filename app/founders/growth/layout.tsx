import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveFounder } from "@/lib/founders/gate";
import { GROWTH_SECTIONS } from "@/lib/founders/growth-shell";
import { FOUNDERS_PORTAL } from "@/lib/portals/registry";
import { isFinanceOwnerEmail } from "@/lib/founders-finances/access";
import { FoundersPortalBanner } from "@/components/founders/FoundersPortalBanner";

export default async function GrowthLayout({ children }: { children: React.ReactNode }) {
  // Defence in depth: keep this gate even though app/founders/layout.tsx also
  // checks it. A future layout move must fail closed rather than expose a route.
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <div className="space-y-6">
      {/* The founders portal banner (wordmark, tagline, section chips) lives
          HERE, on the inactive Growth preview shell, the one founders section
          that still shows it. It used to be mounted by app/founders/layout.tsx
          above every founders page and hidden on Content and Finances in the
          browser; now no Content or Finances page has it in its layout chain.
          The sections are filtered on the server: the Finances chip only for
          the two owners, since the portal gate also admits the marketing hire. */}
      <FoundersPortalBanner
        label={FOUNDERS_PORTAL.label}
        tagline={FOUNDERS_PORTAL.tagline}
        sections={FOUNDERS_PORTAL.sections.filter(
          (s) => s.audience !== "finance_owners" || isFinanceOwnerEmail(founder.email),
        )}
      />
      <nav aria-label="Marketing sections" className="flex flex-wrap gap-2">
        {GROWTH_SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="rounded-full border border-cyan-400/25 px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-cyan-300/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
          >
            {section.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
