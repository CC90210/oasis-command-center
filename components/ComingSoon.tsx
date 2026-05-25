import { Card, PageHeader } from "@/components/Card";
import { Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Shared placeholder for routes whose deeper UX is queued. Renders the
 * full sidebar shell so a click-through never hits a 404 — instead the
 * operator sees the route exists, what it'll do, and which related
 * surfaces work today.
 *
 * Moved 2026-05-25 from components/sunbiz/ to components/ to match
 * reality: this component is mounted by 9+ cross-tenant routes
 * (templates, offers, lenders, funded-deals, email-blast, embed,
 * contacts, commissions, applications) and the SunBiz namespace was a
 * lie that produced the 2026-05-25 cross-tenant copy leak.
 *
 * Body copy is brand-agnostic by design. Per-page bullets come from
 * the caller via `phase2Bullets`.
 */
export function ComingSoon({
  title,
  subtitle,
  icon: Icon,
  phase2Bullets,
  related,
}: {
  title: string;
  subtitle: string;
  icon?: LucideIcon;
  phase2Bullets: string[];
  related?: { href: string; label: string }[];
}) {
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title={title} subtitle={subtitle} />

      <Card>
        <div className="flex items-start gap-4 py-2">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent-soft border border-accent/30 flex items-center justify-center text-accent">
            {Icon ? <Icon size={20} /> : <Sparkles size={20} />}
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <div className="text-fg text-base font-semibold mb-1">Coming Soon</div>
              <p className="text-fg-muted text-sm">
                This page is wired into the Command Center. The deeper
                workflow for this area is queued next; the links below
                are the parts your team can use today.
              </p>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
                Planned upgrades
              </div>
              <ul className="space-y-1.5">
                {phase2Bullets.map((b, i) => (
                  <li key={i} className="text-fg text-sm flex gap-2">
                    <span className="text-accent flex-shrink-0">·</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>

            {related && related.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-2">
                  Working today
                </div>
                <div className="flex flex-wrap gap-2">
                  {related.map((r) => (
                    <a
                      key={r.href}
                      href={r.href}
                      className="px-3 py-1.5 rounded-md bg-bg-elev border border-bg-border text-fg-muted text-xs font-medium hover:bg-bg-hover hover:text-fg transition-colors"
                    >
                      {r.label} →
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
