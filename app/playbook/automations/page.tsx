import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { IndustryAutomationGuide } from "@/components/playbook/IndustryAutomationGuide";

export default function IndustryAutomationPlaybookPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <Link href="/playbook" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent">
        <ArrowLeft size={14} /> Playbook
      </Link>
      <PageHeader
        title="Industry Automation Playbook"
        subtitle="Pick the industry, find the operational leak, and open the right discovery path."
        action={<Tag tone="accent">rep call guide</Tag>}
      />
      <Card title="How to use this on a call" subtitle="Diagnose first. The automation is the answer only after the owner confirms the problem.">
        <ol className="grid gap-3 text-sm text-fg-muted md:grid-cols-3">
          <li><b className="text-fg">1. Pick the closest industry.</b> The catalog is organized around common operating patterns, not rigid labels.</li>
          <li><b className="text-fg">2. Ask one question.</b> Stay with the owner&apos;s answer and quantify the missed calls, time, bookings, or follow-up.</li>
          <li><b className="text-fg">3. Book the scope.</b> Explain the outcome; CC or Adon confirms the exact build, integrations, compliance, and price.</li>
        </ol>
      </Card>
      <Card title="Automation opportunities by industry" subtitle="Website features, workflows attached to the website, and standalone custom builds.">
        <IndustryAutomationGuide />
      </Card>
    </div>
  );
}
