/**
 * SetupReadinessCard — top-of-Settings panel that gives every user
 * (and the owner specifically) a one-glance "what's needed" view.
 *
 * Server component — pulls readiness state via lib/setup-readiness
 * in one round-trip. Renders compact rows with check / dash / cross
 * icons + an inline CTA when the user can act.
 */

import { Card } from "@/components/Card";
import type { ReadinessItem } from "@/lib/setup-readiness";

export function SetupReadinessCard({
  personal,
  tenant,
}: {
  personal: ReadinessItem[];
  tenant: ReadinessItem[] | null;
}) {
  // "info" rows are notes (e.g. "this workspace uses a shared inbox"),
  // not gaps. Only warn/fail count as needs-attention.
  const isGap = (i: ReadinessItem) => i.status === "warn" || i.status === "fail";
  const personalNeedsAttention = personal.some(isGap);
  const tenantNeedsAttention = !!tenant && tenant.some(isGap);
  const headline = (() => {
    if (personalNeedsAttention || tenantNeedsAttention) {
      const personalGaps = personal.filter(isGap).length;
      const tenantGaps = tenant?.filter(isGap).length ?? 0;
      const total = personalGaps + tenantGaps;
      return `${total} item(s) still need attention`;
    }
    return "All set — your account is fully wired.";
  })();
  return (
    <Card
      title="Setup readiness"
      subtitle={headline}
      action={
        <span
          className={`text-[11px] font-bold uppercase tracking-wider ${
            personalNeedsAttention || tenantNeedsAttention
              ? "text-status-warm"
              : "text-status-engaged"
          }`}
        >
          {personalNeedsAttention || tenantNeedsAttention ? "Action required" : "Ready"}
        </span>
      }
    >
      <div className="space-y-5">
        {personal.length > 0 && (
          <Section title="Your personal setup" items={personal} />
        )}
        {tenant && tenant.length > 0 && (
          <Section title="Workspace-wide setup" items={tenant} />
        )}
      </div>
    </Card>
  );
}

function Section({
  title,
  items,
}: {
  title: string;
  items: ReadinessItem[];
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim mb-2">
        {title}
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-start gap-3 text-sm"
          >
            <StatusGlyph status={item.status} />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-fg">{item.label}</div>
              <div className="text-xs text-fg-muted leading-snug mt-0.5">
                {item.detail}
              </div>
            </div>
            {item.cta && (
              <a
                href={item.cta.href}
                className="text-xs text-accent hover:text-accent/80 underline underline-offset-2 shrink-0 mt-0.5"
              >
                {item.cta.label} →
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusGlyph({ status }: { status: ReadinessItem["status"] }) {
  if (status === "ok") {
    return (
      <span
        aria-label="OK"
        className="mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-status-engaged/15 text-status-engaged shrink-0 text-[10px] font-bold"
      >
        ✓
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span
        aria-label="Needs attention"
        className="mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-status-warm/15 text-status-warm shrink-0 text-[10px] font-bold"
      >
        !
      </span>
    );
  }
  if (status === "info") {
    // Distinct icon from "ok" so operators don't read it as "verified."
    return (
      <span
        aria-label="Info"
        className="mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-accent/15 text-accent shrink-0 text-[10px] font-bold"
      >
        i
      </span>
    );
  }
  return (
    <span
      aria-label="Blocker"
      className="mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500/15 text-red-400 shrink-0 text-[10px] font-bold"
    >
      ×
    </span>
  );
}
