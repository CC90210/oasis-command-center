import { Card, PageHeader, Tag } from "@/components/Card";

export function GrowthPlaceholder({
  title,
  subtitle,
  description,
}: {
  title: string;
  subtitle: string;
  description: string;
}) {
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title={title} subtitle={subtitle} />
      <Card
        title="Feature shell"
        subtitle="Visible for workflow review; operational controls are intentionally unavailable."
        action={<Tag tone="neutral">Inactive</Tag>}
      >
        <p className="max-w-2xl text-sm leading-6 text-fg-muted">{description}</p>
        <div className="mt-5 rounded-lg border border-bg-border bg-bg-deep px-4 py-3 text-xs text-fg-dim">
          No credentials, jobs, sends, campaigns, or spend are connected in this release.
        </div>
      </Card>
    </div>
  );
}
