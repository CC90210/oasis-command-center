import { FOUNDER_PLAYBOOK_PATHS, requirePlaybookReader } from "@/lib/playbook-access";
import { viewerReadsInternalAgentNames } from "@/lib/os/agent-names-session";
import Link from "next/link";
import { Card, PageHeader, Tag } from "@/components/Card";
import { listPlaybooks, type PlaybookFile } from "@/lib/playbooks";
import { WEBSITE_PACKAGES } from "@/lib/website-sales";
import { COMPANY_TRACK_BPS, SELF_TRACK_BPS } from "@/lib/website-sales-comp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlaybookSection = {
  href: string;
  title: string;
  subtitle: string;
  body: string;
};

const starterOffer = WEBSITE_PACKAGES.starter;
const percent = (basisPoints: number) => `${basisPoints / 100}%`;

const SECTIONS: PlaybookSection[] = [
  {
    href: "/playbook/deals",
    title: "Website Offer + Deal Architecture",
    subtitle: `$${starterOffer.setupFloor} setup + $${starterOffer.monthlyFloor}/month entry offer - commission - automation upsells`,
    body:
      `The canonical website-first offer starts with Starter at $${starterOffer.setupFloor} setup plus $${starterOffer.monthlyFloor}/month. It includes approved automation add-ons, founder pricing authority, durable rep attribution, and the ${percent(COMPANY_TRACK_BPS.opener)} open / ${percent(COMPANY_TRACK_BPS.closer)} close / ${percent(SELF_TRACK_BPS.open_close)} find-and-close commission ladder on collected setup revenue.`,
  },
  {
    href: "/playbook/script",
    title: "Sales Rep Script",
    subtitle: "Simple talk track - qualify - book CC or Adon",
    body:
      "A plain-language call guide for new appointment setters: 60-second preparation, a word-for-word opener, five qualification questions, easy objection responses, voicemail, booking, and the exact founder handoff.",
  },
  {
    href: "/playbook/automations",
    title: "Industry Automation Playbook",
    subtitle: "Industry menus - discovery questions - website + custom builds",
    body:
      "A call-side catalog of automation opportunities organized by industry. Pick the business type, identify an operational leak, and see what can live on the website, connect to it, or become a custom workflow.",
  },
  {
    href: "/playbook/business",
    title: "Business Documentation",
    subtitle: "Legal - corporate - tax - sales - security - people - strategy",
    body:
      "Every document OASIS AI Solutions keeps, each one open to read, copy and download: the live privacy policy and terms, the contractor agreements, the Law 25 register, the Quebec tax calendar and more. A missing one shows what is needed and can be drafted from verified facts.",
  },
  {
    href: "/playbook/prompts",
    title: "Prompts Library",
    subtitle: "Saved prompts that move the system - operator + client deployment toolkit",
    body:
      "Reusable prompts for daily operations, reviews, system work, and client deployment. Hand one to the department that answers for it, or copy it unchanged for your IDE. Universal agent tools appear once instead of repeating across audiences.",
  },
  {
    href: "/playbook/security",
    title: "Security Model",
    subtitle: "Application-level tenant isolation - AES-256-GCM at rest - SHA-256 bridge tokens",
    body:
      "What you may tell a client. Every workspace shares one Turso (libSQL) database, and the application keeps them apart: every tenant-scoped table carries a tenant_id and every query filters on it. Deployment secrets are Cloudflare Worker secrets, provider keys are encrypted at rest with AES-256-GCM, and bridge tokens are stored only as SHA-256 hashes.",
  },
  {
    href: "/playbook/10-oasis-loop",
    // Title was "10 The OASIS Loop" — the leading "10" was the markdown
    // filename's sort prefix leaking into the UI, which read as a duplicate
    // of the card's own "05" badge once the index was consolidated.
    title: "The OASIS Loop",
    subtitle: "Closed-loop AI interaction - 4 phases - 1 clean chat",
    body:
      "The method for getting production-grade output from any AI system. Two AIs — a Prompt Engineer that translates your raw ideas into precision instructions, and an Executor that builds — sharing one agent harness. Prime, Translate, Execute, Reflect. The translator's system message is the Prompt translator entry in the Prompts Library.",
  },
];

export default async function PlaybookIndex() {
  // OASIS members only (lib/playbook-access.ts); everyone else gets the 404.
  await requirePlaybookReader();
  // Single-source rule: a runbook that already has its own numbered card
  // above must not ALSO appear in the operating manual below. Deduping by href
  // (rather than hardcoding the slug) means any future card that points at a
  // markdown file is deduped automatically instead of drifting.
  //
  // The SunBiz branch and its slug filter are gone: SunBiz retired on
  // 2026-09-28 and its playbooks (01-06, 08, INDEX) left content/playbooks.
  const cardHrefs = new Set(SECTIONS.map((s) => s.href));
  const operatingManual = listPlaybooks().filter((f) => !cardHrefs.has(`/playbook/${f.slug}`));
  // The founders' pages (lib/playbook-access.ts FOUNDER_PLAYBOOK_PATHS) are a
  // 404 for everyone else, so only a founder is shown their cards.
  const founder = await viewerReadsInternalAgentNames();
  const sections = founder ? SECTIONS : SECTIONS.filter((s) => !FOUNDER_PLAYBOOK_PATHS.includes(s.href));
  return <DefaultPlaybookIndex sections={sections} operatingManual={operatingManual} />;
}

function DefaultPlaybookIndex({ sections, operatingManual }: { sections: PlaybookSection[]; operatingManual: PlaybookFile[] }) {
  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        title="Playbook"
        subtitle="Lean operating knowledge for selling, delivering, and improving OASIS AI."
        action={<Tag tone="accent">current</Tag>}
      />

      {/* Uniform-height grid - every card stretches to match the tallest
          card in its row so the lineup reads as a clean lattice instead
          of the prior mangled-blocks look. `h-full` on the wrapper +
          card + content makes CSS Grid sync row heights; line-clamp on
          the body caps long descriptions at 5 lines so a single
          paragraph doesn't push everything else taller. CC's feedback
          2026-05-22: "they need to be the same size, not weird
          different-size blocks." */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {sections.map((section, index) => {
          return (
            <Link
              key={`${section.href}-${index}`}
              href={section.href}
              className="group block h-full"
            >
              <Card className="h-full">
                <div className="flex items-start gap-4 h-full">
                  <div className="w-11 h-11 rounded-lg bg-accent-soft border border-accent-muted/30 flex items-center justify-center shrink-0 text-accent font-bold tracking-[0.16em] group-hover:bg-accent group-hover:text-bg transition-all">
                    {(index + 1).toString().padStart(2, "0")}
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col">
                    <div className="text-fg font-bold text-base group-hover:text-accent transition-colors">
                      {section.title}
                    </div>
                    <div className="text-xs text-fg-muted mt-0.5 uppercase tracking-wider font-medium">
                      {section.subtitle}
                    </div>
                    <p className="text-sm text-fg-muted mt-3 leading-relaxed line-clamp-5">
                      {section.body}
                    </p>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      {operatingManual.length > 0 && (
        <section id="operating-manual" className="space-y-4 scroll-mt-6">
          <div>
            <h2 className="text-lg font-bold text-fg">Operating manual</h2>
            <p className="text-sm text-fg-muted">
              Canonical runbooks that need full detail. Keep the index compact;
              keep execution truth in one source.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {operatingManual.map((file) => (
              <Link
                key={file.slug}
                href={`/playbook/${file.slug}`}
                className="group block h-full"
              >
                <Card className="h-full">
                  <div className="flex items-start gap-3 h-full">
                    <div className="flex-1 min-w-0">
                      <div className="text-fg font-semibold group-hover:text-accent transition-colors">
                        {file.title}
                      </div>
                      <div className="text-[11px] text-fg-dim mt-1 uppercase tracking-wider font-mono">
                        {file.audience} - {file.slug}.md
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
