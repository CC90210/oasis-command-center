"use client";

/**
 * The "OASIS · Founders Portal" banner at the top of every founders page:
 * wordmark, tagline and the section chips (FoundersSectionNav).
 *
 * NOT on Finances. CC, 2026-09-24: "remove the Oasis founder portal section at
 * the very top, where I can switch between marketing and finances... this is
 * unnecessary." Finances pages start with their own tab bar; Marketing is one
 * click away in the left sidebar. Every other founders page keeps the banner.
 *
 * A client component only because the founders layout is a server component
 * and cannot see the pathname. It decides nothing about access: the layout
 * still runs the founder gate, and filters the sections by audience (the
 * Finances chip only for the two owners) before passing them in.
 */

import { usePathname } from "next/navigation";
import type { PortalSection } from "@/lib/portals/registry";
import { FoundersSectionNav } from "./FoundersSectionNav";

const FINANCES_PREFIX = "/founders/finances";

/** True where the portal banner does not render. PURE, for the test. */
export function foundersBannerHidden(pathname: string): boolean {
  return pathname === FINANCES_PREFIX || pathname.startsWith(`${FINANCES_PREFIX}/`);
}

export function FoundersPortalBanner({ label, tagline, sections }: { label: string; tagline: string; sections: PortalSection[] }) {
  const pathname = usePathname() || "";
  if (foundersBannerHidden(pathname)) return null;
  return (
    // The one piece of chrome that says "you have left the CRM". Cyan
    // hairline + wordmark, matching the OASIS brand system.
    <div
      className="rounded-xl border px-5 py-3.5"
      style={{
        borderColor: "rgba(31,227,240,0.22)",
        background: "linear-gradient(90deg, rgba(31,227,240,0.07) 0%, rgba(31,227,240,0.02) 55%, transparent 100%)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#1FE3F0", boxShadow: "0 0 10px rgba(31,227,240,0.7)" }} aria-hidden />
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em]" style={{ color: "#1FE3F0" }}>
              {label}
            </div>
            <div className="mt-0.5 text-[11px] text-fg-dim">{tagline}</div>
          </div>
        </div>

        {/* Sub-section chips render only inside their parent (see
            FoundersSectionNav); the Finances chip arrives only for the owners. */}
        <FoundersSectionNav sections={sections} />
      </div>
    </div>
  );
}
