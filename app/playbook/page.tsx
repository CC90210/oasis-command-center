import Link from "next/link";
import { cookies } from "next/headers";
import { Card, PageHeader, Tag } from "@/components/Card";
import { safe } from "@/lib/api-helpers";
import {
  DEMO_CLIENT_PROFILE_COOKIE,
  getClientCommandCenterProfileById,
  resolveClientProfileSlug,
} from "@/lib/client-profiles";
import { listPlaybooks, type PlaybookFile } from "@/lib/playbooks";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { demoHref } from "@/lib/demo-href";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlaybookSection = {
  href: string;
  title: string;
  subtitle: string;
  body: string;
};

const SECTIONS: PlaybookSection[] = [
  {
    href: "/playbook/script",
    title: "Cold Call Script + Objections",
    subtitle: "5 stages - 4 tracks - 10 objections - secondary disarm",
    body:
      "One memorize-grade page. Pattern interrupt, reason, diagnose, pivot, close. Pick your prospect track at the top and run the right language live. Includes the Agree/Validate/Isolate disarm for when prospects double down on 'we're good'.",
  },
  {
    href: "/playbook/deals",
    title: "Deal Architecture",
    subtitle: "Three offers - two partner paths - one decision rule",
    body:
      "Three client offers, two partner paths, and the canonical 50% strategic-partner model. The math is simple enough to defend in any room.",
  },
  {
    href: "/playbook/drills",
    title: "Daily Drills",
    subtitle: "5 reps - 30 min/day - 90-day discipline",
    body:
      "Mirror Run, Objection Volley, Recording Review, KPI Log, Weekly Retro. The boring discipline that turns cold calling into muscle memory.",
  },
  {
    href: "/playbook/business",
    title: "Business Documentation",
    subtitle: "CEO + CFO + CMO + Ops + Legal - every doc a real company needs",
    body:
      "The full hub of business documentation. Manifesto, OKRs, P&L, runway, brand bible, content pillars, MSA template, onboarding SOP, incident runbook. Each pillar owned by the right AI exec - click any doc to ask them to draft or refresh it.",
  },
  {
    href: "/playbook/prompts",
    title: "Prompts Library",
    subtitle: "Saved prompts that move the system - operator + client deployment toolkit",
    body:
      "Reusable prompts for every recurring move. Two audiences: yours (daily ops, system health, [OVERRIDE] syntax) and the client deployment toolkit (setup, voice tune, integration audit, handoff). Foundational prompts are hard-coded; mutable ones can grow as you find new patterns. Click any prompt to drop it straight into chat.",
  },
  {
    href: "/playbook/client-deploy",
    title: "Client Deployment Runbook",
    subtitle: "Six phases - ~60 minutes - the canonical onboarding playbook",
    body:
      "Your step-by-step runbook for spinning up a fresh client. Pre-flight -> bootstrap -> personalize -> integrations -> scope -> handoff. Each step has a chat-fire prompt that runs the move automatically. Use this for every new client - same arc, different tenant.",
  },
  {
    href: "/playbook/client-deploy",
    title: "Multi-Machine Setup",
    subtitle: "Pair desktop + laptop - production daemons stay singular - chat-server per machine",
    body:
      "Clients with multiple machines (desktop + laptop) pair both bridges to the same dashboard tenant. The dashboard auto-detects which bridge is local. Hard rule: only ONE machine runs scheduler / skool / telegram daemons (state mutators). Every other machine runs ONLY the chat-server. The pair endpoint is idempotent by machine_fingerprint, so re-running rotates tokens instead of creating duplicates. See brain/MULTI_MACHINE_PAIRING_PROMPT.md for the paste-ready Antigravity prompt.",
  },
  {
    href: "/playbook/onboarding",
    title: "Operator Onboarding (V6.0)",
    subtitle: "What your agent does - Safe asks - Escalation triggers - Pause + rollback",
    body:
      "Four short SOPs for new operators. Render markdown directly from docs/playbooks/ so non-technical clients can read the agent's contract in the dashboard without opening the repo. Update the markdown, redeploy, and every operator sees the new SOP next refresh.",
  },
  {
    href: "/playbook/security",
    title: "Security Model",
    subtitle: "Multi-tenant RLS - AES-256-GCM at rest - SHA-256 bridge tokens - HMAC self-pair",
    body:
      "How tenant isolation, encryption, and bridge authentication actually work. Every tenant-scoped table is RLS-protected at the Postgres layer. Provider API keys encrypted at rest with AES-256-GCM (scrypt KDF, deploy-wide BRAVO_FIELD_ENCRYPTION_KEY). Bridge tokens are SHA-256 hashed before storage. Self-pair from the daemon uses HMAC headers verified server-side. Migration 030 enforces one live pairing per (tenant, machine_fingerprint) at the DB layer. Read brain/SECURITY_MODEL.md for the full architecture.",
  },
];

// SunBiz feature manual - the card grid the SunBiz operator sees on /playbook.
// Each card opens either a rich-markdown guide in content/playbooks/sun-*.md or
// the live HTML email template gallery. Keep this specific to SunBiz funding
// ops; generic client onboarding belongs in the OASIS portal, not here.
const SUNBIZ_SECTIONS: PlaybookSection[] = [
  {
    href: "/playbook/sun-15-email-templates",
    title: "HTML Outreach Pipeline",
    subtitle: "Pick design - send with Helios - create new HTML",
    body:
      "Start here. The workflow for turning an approved SunBiz HTML into an agent-assisted email send, plus the rules for creating brand-new HTML assets.",
  },
  {
    href: "/templates",
    title: "Template Library",
    subtitle: "28 templates - merge fields - preview - copy HTML",
    body:
      "The production SunBiz HTML library. Preview the design, check required variables like {{first_name}}, launch Helios with the selected template, or start a new HTML build.",
  },
  {
    href: "/playbook/sun-12-pipeline",
    title: "Merchant Pipeline",
    subtitle: "Leads - applications - shopping out - conversations - campaigns",
    body:
      "Prospect to application. Work the lead board, chase bank statements, move complete files into applications, shop them to lenders, and keep every merchant thread clean.",
  },
  {
    href: "/playbook/sun-13-deals",
    title: "Deals",
    subtitle: "Offers - renewals - commissions - lender book",
    body:
      "Post-shop. Read lender replies, compare offers, present the right option, book funded deals, watch renewal timing, and keep the lender criteria accurate.",
  },
  {
    href: "/playbook/sun-14-system",
    title: "Systems",
    subtitle: "Import - forms - sequences - team - automations - settings",
    body:
      "The plumbing Ezra, Ethan, and Matt rely on: CSV imports, per-rep form links, follow-up sequences, team access, worker health, and owner-level settings.",
  },
  {
    href: "/playbook/sun-11-operations",
    title: "Agent Desk",
    subtitle: "Dashboard - Solara - Helios - reasoning - manual",
    body:
      "The command desk. Use the dashboard to pick the next file, Solara for funding ops, Helios for sales language, and Reasoning for one-click deal prompts.",
  },
];

const SUN_MANUAL_ORDER = [
  "sun-15-email-templates",
  "sun-12-pipeline",
  "sun-13-deals",
  "sun-14-system",
  "sun-11-operations",
  "sun-10-getting-started",
] as const;

const LEGACY_SUN_ONBOARDING_SLUGS = [
  "01-getting-started",
  "02-safe-interaction",
  "03-when-to-call-cc",
  "04-pause-and-rollback",
] as const;

// Slugs that belong to the SunBiz operating manual and must NEVER appear on
// the OASIS Playbook index (otherwise "Meet Solara" leaks into CC's portal).
// The frontmatter-driven check in isSunBizPlaybook() below is the
// future-proofing layer — any new playbook with `audience: sunbiz-*` or a
// `sun` / `sunbiz` slug prefix is auto-excluded without needing an entry here.
const SUN_PLAYBOOK_SLUGS = new Set<string>([
  ...SUN_MANUAL_ORDER,
  ...LEGACY_SUN_ONBOARDING_SLUGS,
  "05-customer-onboarding-script",
  "06-sunbiz-runbook",
  "08-sunbiz-production-pre-flight",
]);

/**
 * A playbook belongs to the SunBiz portal when slug matches the explicit
 * allowlist, contains a known SunBiz keyword, or the frontmatter
 * audience/tags declare SunBiz scope. Empire-operator-audience docs
 * about SunBiz (e.g. the pre-flight) stay in SUN_PLAYBOOK_SLUGS above
 * since audience alone wouldn't catch them.
 */
function isSunBizPlaybook(file: PlaybookFile): boolean {
  if (SUN_PLAYBOOK_SLUGS.has(file.slug)) return true;
  const lowered = file.slug.toLowerCase();
  if (
    lowered.includes("sunbiz") ||
    lowered.includes("solara") ||
    lowered.includes("helios") ||
    // The SunBiz feature manual docs (sun-10-getting-started, sun-11-operations,
    // ...). Slug-based so it survives the frontmatter strip in lib/playbooks.ts
    // (which removes the tags: line the body checks below rely on).
    lowered.startsWith("sun-")
  ) {
    return true;
  }
  // Bound the scan to the document head so giant playbooks don't pay a
  // body-wide regex cost on every render.
  const head = file.body.slice(0, 600).toLowerCase();
  const audienceLine = head.match(/^audience:\s*(.+?)\s*$/m)?.[1] ?? "";
  if (
    audienceLine.includes("sunbiz") ||
    audienceLine.includes("solara") ||
    audienceLine.includes("helios") ||
    audienceLine.startsWith("sun-")
  ) {
    return true;
  }
  const tagsLine = head.match(/^tags:\s*\[(.+?)\]/m)?.[1] ?? "";
  if (tagsLine.includes("sunbiz") || tagsLine.includes("solara") || tagsLine.includes("helios")) {
    return true;
  }
  return false;
}

const SUN_MANUAL_META: Record<string, { eyebrow: string; summary: string }> = {
  "sun-15-email-templates": {
    eyebrow: "HTML",
    summary: "The template-to-agent pipeline, merge fields, preview flow, send handoff, and new-template build path.",
  },
  "sun-12-pipeline": {
    eyebrow: "Pipeline",
    summary: "How leads become complete applications and lender-ready files.",
  },
  "sun-13-deals": {
    eyebrow: "Deals",
    summary: "How offers, renewals, commissions, and lender criteria stay in sync.",
  },
  "sun-14-system": {
    eyebrow: "Systems",
    summary: "Imports, forms, sequences, team access, automations, and settings.",
  },
  "sun-11-operations": {
    eyebrow: "Desk",
    summary: "Dashboard triage, Solara/Helios usage, and Reasoning prompt shortcuts.",
  },
  "sun-10-getting-started": {
    eyebrow: "Map",
    summary: "The deal spine, daily rhythm, and Ezra/Ethan/Matt ownership lanes.",
  },
};

export default async function PlaybookIndex() {
  const operatingManual = await listPlaybooks();
  const profile = await safe("playbook.profile", getActiveProfile(), null);
  const rawDemoProfileSlug = (await cookies()).get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
  const demoProfileSlug = profile?.tenant_id ? null : rawDemoProfileSlug;
  const demoProfile = getClientCommandCenterProfileById(demoProfileSlug);
  const tenantProfileSlug =
    demoProfile.id !== "default"
      ? demoProfile.id
      : profile?.tenant_id
        ? await safe(
            "playbook.tenant_profile_slug",
            (async () => {
              const tenant = await getTenant(profile.tenant_id || "");
              return resolveClientProfileSlug(tenant);
            })(),
            null
          )
        : null;

  if (tenantProfileSlug === "sun") {
    const manualFiles = SUN_MANUAL_ORDER
      .map((slug) => operatingManual.find((file) => file.slug === slug) || null)
      .filter((file): file is PlaybookFile => file !== null);
    return <SunBizPlaybookIndex manualFiles={manualFiles} demoMode={demoProfile.id === "sun"} />;
  }

  const defaultManual = operatingManual.filter((f) => !isSunBizPlaybook(f));
  return <DefaultPlaybookIndex operatingManual={defaultManual} />;
}

function DefaultPlaybookIndex({ operatingManual }: { operatingManual: PlaybookFile[] }) {
  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        title="Playbook"
        subtitle="The canonical sales operating manual. Memorize the script. Drill the objections. Close the deal."
        action={<Tag tone="accent">v3 - canonical</Tag>}
      />

      {/* Uniform-height grid — every card stretches to match the tallest
          card in its row so the lineup reads as a clean lattice instead
          of the prior mangled-blocks look. `h-full` on the wrapper +
          card + content makes CSS Grid sync row heights; line-clamp on
          the body caps long descriptions at 5 lines so a single
          paragraph doesn't push everything else taller. CC's feedback
          2026-05-22: "they need to be the same size, not weird
          different-size blocks." */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {SECTIONS.map((section, index) => {
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
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-bold text-fg">Operating manual</h2>
            <p className="text-sm text-fg-muted">
              Verbatim scripts and deployment runbooks. Read top-to-bottom on the
              call. Don&apos;t paraphrase.
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

function SunBizPlaybookIndex({
  manualFiles,
  demoMode = false,
}: {
  manualFiles: PlaybookFile[];
  demoMode?: boolean;
}) {
  const playbookEntryHref = (slug: string) => demoHref(`/playbook/${slug}`, { demoMode });
  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        title="Playbook"
        subtitle="Your SunBiz operating manual. Start with the HTML Outreach Pipeline, then work the funding flow."
        action={<Tag tone="engaged">SunBiz ops</Tag>}
      />

      {/* Feature manual - one card per area of the Command Center. */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {SUNBIZ_SECTIONS.map((section, index) => (
          <Link
            key={section.href}
            href={
              section.href.startsWith("/playbook/")
                ? playbookEntryHref(section.href.replace("/playbook/", ""))
                : section.href
            }
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
        ))}
      </div>

      {manualFiles.length > 0 && (
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-bold text-fg">SunBiz operating guides</h2>
            <p className="text-sm text-fg-muted">
              Practical guides for Ezra, Ethan, and Matt. These are the live
              operating docs behind the cards above.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {manualFiles.map((file, index) => {
              const meta = SUN_MANUAL_META[file.slug] || {
                eyebrow: `Step ${(index + 1).toString().padStart(2, "0")}`,
                summary: file.title,
              };
              return (
                <Link key={file.slug} href={playbookEntryHref(file.slug)} className="group block h-full">
                  <Card className="h-full">
                    <div className="space-y-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] font-bold text-accent">
                        {meta.eyebrow}
                      </div>
                      <div className="text-fg font-semibold group-hover:text-accent transition-colors">
                        {file.title}
                      </div>
                      <p className="text-xs text-fg-muted leading-relaxed line-clamp-3">{meta.summary}</p>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
