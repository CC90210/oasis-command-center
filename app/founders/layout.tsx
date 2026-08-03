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
 * sub-nav so the boundary is obvious the moment you look at the screen.
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

import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveFounder } from "@/lib/founders/gate";
import { FOUNDERS_PORTAL } from "@/lib/portals/registry";

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
      {/* Portal banner. The one piece of chrome that says "you have left the
          CRM". Cyan hairline + wordmark, matching the OASIS brand system. */}
      <div
        className="rounded-xl border px-5 py-3.5"
        style={{
          borderColor: "rgba(31,227,240,0.22)",
          background:
            "linear-gradient(90deg, rgba(31,227,240,0.07) 0%, rgba(31,227,240,0.02) 55%, transparent 100%)",
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "#1FE3F0", boxShadow: "0 0 10px rgba(31,227,240,0.7)" }}
              aria-hidden
            />
            <div>
              <div
                className="text-[10px] font-bold uppercase tracking-[0.22em]"
                style={{ color: "#1FE3F0" }}
              >
                {FOUNDERS_PORTAL.label}
              </div>
              <div className="mt-0.5 text-[11px] text-fg-dim">
                {FOUNDERS_PORTAL.tagline}
              </div>
            </div>
          </div>

          <nav className="flex flex-wrap items-center gap-1.5">
            {FOUNDERS_PORTAL.sections.map((s) =>
              s.enabled ? (
                <Link
                  key={s.href}
                  href={s.href}
                  className="rounded-full border px-3 py-1.5 text-xs font-medium text-fg-muted transition-all hover:text-fg"
                  style={{ borderColor: "rgba(31,227,240,0.22)" }}
                >
                  {s.label}
                </Link>
              ) : (
                <span
                  key={s.href}
                  className="cursor-default rounded-full border border-bg-border px-3 py-1.5 text-xs font-medium text-fg-dim/60"
                  title={`${s.label} — not built yet`}
                >
                  {s.label}
                </span>
              ),
            )}
          </nav>
        </div>
      </div>

      {children}
    </div>
  );
}
