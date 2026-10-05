"use client";

/**
 * Header chips for the founders portal.
 *
 * Top-level destinations (Marketing, Finances) always show. A section with a
 * `parent` (Marketing's Library / Train / Performance) shows only while the
 * viewer is inside that parent — so Marketing's sub-pages never appear on a
 * Finances page, and Finances' own tabs live in its own layout instead of up
 * here. The rule is lib/portals/registry.ts visibleFoundersSections (pure,
 * tested); this component only needs the pathname to apply it.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { visibleFoundersSections, type PortalSection } from "@/lib/portals/registry";

export function FoundersSectionNav({ sections }: { sections: PortalSection[] }) {
  const pathname = usePathname() || "";
  const { chips, active } = visibleFoundersSections(pathname, sections);
  const top = chips.filter((s) => !s.parent);
  const sub = chips.filter((s) => s.parent);

  const chip = (s: PortalSection) => {
    if (!s.enabled) {
      return (
        <span
          key={s.href}
          className="cursor-default rounded-full border border-bg-border px-3 py-1.5 text-xs font-medium text-fg-dim/60"
          title={`${s.label} — not built yet`}
        >
          {s.label}
        </span>
      );
    }
    const isActive = s.href === active;
    return (
      <Link
        key={s.href}
        href={s.href}
        aria-current={isActive ? "page" : undefined}
        className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
          isActive ? "text-fg" : "text-fg-muted hover:text-fg"
        }`}
        style={{
          borderColor: isActive ? "rgba(31,227,240,0.55)" : "rgba(31,227,240,0.22)",
          background: isActive ? "rgba(31,227,240,0.08)" : undefined,
        }}
      >
        {s.label}
      </Link>
    );
  };

  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Founders sections">
      {top.map(chip)}
      {sub.length > 0 && <span className="mx-1 h-4 w-px bg-bg-border" aria-hidden />}
      {sub.map(chip)}
    </nav>
  );
}
