/**
 * MarketingToday — the marketing employee's dashboard.
 *
 * WHY IT EXISTS AT ALL: app/page.tsx dispatches Today by persona, and any
 * persona without a branch falls through to FounderToday. FounderToday takes
 * `showFinancials` and consults no other capability, so a marketing hire would
 * have seen the tenant's whole pipeline and the company inbound tape — both
 * denied by their capability record. That is the same leak the manager persona
 * shipped with, and it is not repeated here.
 *
 * DELIBERATELY SMALL. This surface reads NOTHING from the database. Marketing's
 * actual tools already exist and are already good — /founders/marketing has the
 * library, the training set and the performance board. Duplicating any of that
 * here would mean two places to keep true, and the second one would rot.
 *
 * So this is a router with a shape: it orients the person and sends them to the
 * real tool. No stat tiles invented to fill space, and above all no numbers —
 * a fabricated metric on a dashboard is worse than an empty one, because a
 * plausible number gets believed and acted on.
 */

import Link from "next/link";
import { Card, PageHeader } from "@/components/Card";
import { LiveClock } from "@/components/LiveClock";
import { operatorDateKey } from "@/lib/dates";

export function MarketingToday({ viewerName }: { viewerName: string }) {
  const dateKey = operatorDateKey();
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Today"
        subtitle={
          <span>
            {viewerName} · <LiveClock initialDateKey={dateKey} /> · marketing
          </span>
        }
      />

      <Card
        title="Marketing studio"
        subtitle="Where the work happens — library, training, and published performance."
      >
        <div className="flex flex-wrap gap-2">
          <Link href="/founders/marketing" className="btn-primary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
            Open Marketing
          </Link>
          <Link href="/founders/marketing/library" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
            Library
          </Link>
          <Link href="/founders/marketing/performance" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
            Performance
          </Link>
        </div>
      </Card>

      <Card title="Playbook" subtitle="Brand voice, the offer, and the language that converts.">
        <p className="text-sm leading-relaxed text-fg-muted">
          The playbook is the source for how OASIS talks about itself — the offer, the objections,
          and the words that have actually closed deals. Write from it rather than around it.
        </p>
        <div className="mt-3">
          <Link href="/playbook" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
            Open playbook
          </Link>
        </div>
      </Card>

      <Card title="What you will not see here" subtitle="Said out loud so it reads as a boundary, not a bug.">
        <p className="text-sm leading-relaxed text-fg-muted">
          Company revenue, the sales pipeline and the commission ledger are not part of this
          role. If you need a number for a campaign or a case study, ask CC — that is a
          deliberate boundary, not a missing page.
        </p>
      </Card>
    </div>
  );
}
