import { Card, PageHeader, Tag } from "@/components/Card";

const lanes = [
  ["Organic", "Plan distribution and monitor connected social channels."],
  ["Paid Ads", "Prepare Meta and Google acquisition behind the existing spend gate."],
  ["Outreach", "Coordinate compliant prospecting and dispatch through Xerneas."],
] as const;

export default function GrowthPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Marketing"
        subtitle="OASIS acquisition workspace · shell preview"
        action={<Tag tone="neutral">Inactive</Tag>}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {lanes.map(([title, description]) => (
          <Card key={title} title={title} subtitle="Feature shell">
            <p className="text-sm leading-6 text-fg-muted">{description}</p>
            <div className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-fg-dim">
              No live controls
            </div>
          </Card>
        ))}
      </div>
      <Card title="Account Connections" subtitle="Credential vault lands in Feature 2">
        <p className="text-sm text-fg-muted">
          SMTP, SMS, social, and advertising providers are shown in the navigation only. Nothing can be entered or saved yet.
        </p>
      </Card>
    </div>
  );
}
