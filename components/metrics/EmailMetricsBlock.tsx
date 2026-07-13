import { Stat, Tag } from "@/components/Card";
import type { EmailMetrics } from "@/lib/metrics/types";

function pct(v: number, digits = 1): string {
  if (!isFinite(v)) return "0%";
  return `${(v * 100).toFixed(digits)}%`;
}
const num = (v: number): string => v.toLocaleString();

/**
 * The one Constant-Contact-parity metric block, rendered for every source in the
 * Metrics tab. Sent / Delivered / Bounces, Opens (total + unique) + open rate,
 * Clicks (total + unique) + click rate + click-to-open, Unsubscribes, Complaints.
 */
export function EmailMetricsBlock({ metrics: m }: { metrics: EmailMetrics }) {
  if (m.sent === 0) {
    return <div className="text-sm text-fg-dim py-3">No email sent in this window yet.</div>;
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <Stat label="Sent" value={num(m.sent)} />
        <Stat label="Delivered" value={num(m.delivered)} hint={pct(m.deliveryRate)} />
        <Stat label="Bounces" value={num(m.bounces)} hint={pct(m.bounceRate, 2)} />
        <Stat label="Open rate" value={pct(m.openRate)} hint={`${num(m.uniqueOpens)} unique`} accent />
        <Stat label="Click rate" value={pct(m.clickRate)} hint={`${num(m.uniqueClicks)} unique`} accent />
        <Stat label="Click-to-open" value={pct(m.ctor)} hint="of openers clicked" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <Stat label="Opens (total)" value={num(m.opens)} />
        <Stat label="Clicks (total)" value={num(m.clicks)} />
        <Stat label="Did not open" value={num(m.didNotOpen)} />
        <Stat label="Unsubscribes" value={num(m.unsubscribes)} hint={pct(m.unsubRate, 2)} />
        <Stat label="Spam complaints" value={num(m.complaints)} hint={pct(m.complaintRate, 2)} />
        <div className="flex items-end pb-2">
          {m.isProxy && <Tag tone="warm">bounce/opt-out = proxy</Tag>}
        </div>
      </div>
    </div>
  );
}
