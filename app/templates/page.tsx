"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import { Card, PageHeader, Tag } from "@/components/Card";
import {
  COLD_OUTREACH_TEMPLATES,
  type ColdOutreachTemplate,
} from "@/lib/cold-outreach/templates.generated";
import {
  ArrowLeft,
  Braces,
  Check,
  Copy,
  Eye,
  FileCode2,
  Mail,
  PlusCircle,
  Search,
  Send,
  WandSparkles,
  X,
} from "lucide-react";

type Category =
  | "all"
  | "first-touch"
  | "sequence"
  | "follow-up"
  | "consolidation"
  | "vertical"
  | "seasonal";

type TemplateMeta = ColdOutreachTemplate & {
  category: Exclude<Category, "all">;
  sizeKb: number;
  tokens: string[];
  sourcePath: string;
};

type AgentKey = "helios" | "solara";

const CATEGORY_ORDER: Category[] = [
  "all",
  "first-touch",
  "sequence",
  "follow-up",
  "consolidation",
  "vertical",
  "seasonal",
];

const CATEGORY_META: Record<Category, { label: string; description: string }> = {
  all: {
    label: "All",
    description: "Every SunBiz HTML email template.",
  },
  "first-touch": {
    label: "First Touch",
    description: "Cold outreach, capital offers, and opening emails.",
  },
  sequence: {
    label: "T1-T5 Cadence",
    description: "The numbered outbound sequence templates.",
  },
  "follow-up": {
    label: "Follow-Up",
    description: "Abandoned application, re-engagement, referral, bump, and breakup copy.",
  },
  consolidation: {
    label: "Consolidation",
    description: "Debt stack and multi-position consolidation emails.",
  },
  vertical: {
    label: "Vertical",
    description: "Construction, restaurant, retail, and niche industry angles.",
  },
  seasonal: {
    label: "Seasonal",
    description: "New year, summer, Q2, and year-end campaign timing.",
  },
};

const SAMPLE_VALUES: Record<string, string> = {
  first_name: "Taylor",
  business_name: "Evergreen Auto Group",
  year: String(new Date().getFullYear()),
  unsubscribe_url: "https://sunbizfunding.com/unsubscribe/example",
  rep_name: "Ezra",
  rep_title: "Funding Specialist",
  rep_phone: "(786) 555-0184",
  rep_email: "ezra@sunbizfunding.com",
  city: "Miami",
  industry: "auto repair",
  prequal_amount: "$75,000",
  referral_reward: "$500",
};

function inferCategory(key: string): TemplateMeta["category"] {
  const k = key.toLowerCase();
  if (/^t[1-5]_/.test(k)) return "sequence";
  if (k.includes("consolidation")) return "consolidation";
  if (
    k.includes("construction") ||
    k.includes("restaurant") ||
    k.includes("retail") ||
    k.includes("trades") ||
    k.includes("hospitality") ||
    k.includes("ecommerce")
  ) {
    return "vertical";
  }
  if (
    k.includes("new_year") ||
    k.includes("summer") ||
    k.includes("year_end") ||
    k.includes("seasonal") ||
    k.includes("q2")
  ) {
    return "seasonal";
  }
  if (
    k.includes("abandoned") ||
    k.includes("re_engagement") ||
    k.includes("referral") ||
    k.includes("bump") ||
    k.includes("breakup")
  ) {
    return "follow-up";
  }
  return "first-touch";
}

function extractTokens(html: string): string[] {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    tokens.add(match[1]);
  }
  return [...tokens].sort((a, b) => a.localeCompare(b));
}

function renderPreviewHtml(template: TemplateMeta): string {
  return template.html.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token) => {
    return SAMPLE_VALUES[token] ?? `[${token}]`;
  });
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Copy this HTML:", text);
    return false;
  }
}

function agentHref(agent: AgentKey, prompt: string): string {
  const params = new URLSearchParams({
    agent,
    prompt,
  });
  return `/agent?${params.toString()}`;
}

function buildUseWithAgentPrompt(template: TemplateMeta): string {
  return [
    `Use the approved SunBiz HTML email template "${template.name}" for an outbound email.`,
    `Template key: ${template.key}`,
    `Template source: ${template.sourcePath}`,
    `Suggested subject: ${template.subject}`,
    `Required merge fields: ${template.tokens.map((token) => `{{${token}}}`).join(", ") || "none"}.`,
    "",
    "First ask which lead, recipient, or campaign list this is for. Then prepare the email using this exact HTML design, fill the merge fields from the selected record where possible, and show the merged subject plus a send-ready preview.",
    "",
    "Do not send anything until the operator explicitly approves the recipient, variables, unsubscribe link, and final copy.",
  ].join("\n");
}

function buildCreateHtmlPrompt(reference?: TemplateMeta): string {
  const referenceLine = reference
    ? [
        `Create a new variant based on "${reference.name}".`,
        `Reference key: ${reference.key}`,
        `Reference source: ${reference.sourcePath}`,
        `Reference subject: ${reference.subject}`,
        `Current merge fields: ${reference.tokens.map((token) => `{{${token}}}`).join(", ") || "none"}.`,
      ].join("\n")
    : "Create a brand-new SunBiz HTML email from the SunBiz brand style and ask what campaign this new asset is for.";
  return [
    "You are Solara handling SunBiz template production, not Helios outreach.",
    referenceLine,
    "",
    "Before drafting, ask for: campaign goal, target audience or vertical, sender lane (Ezra, Ethan, or Matt), CTA, required merge fields, and whether this is cold outreach, follow-up, consolidation, seasonal, or vertical.",
    "",
    "Draft responsive email-safe HTML with SunBiz branding, the required unsubscribe link, and a concise subject line. Do not send or hand off to Helios until the operator approves the asset. If your current runtime cannot write to oasis-command-center directly, return the full HTML, a proposed filename under lib/cold-outreach/templates/, and the regeneration command for templates.generated.ts.",
    "MANDATORY in EVERY funding email — regardless of campaign, audience, vertical, or season — show SunBiz funding tiers using ONLY these locked 1.25-factor figures (never invent, round, or relabel), with the WEEKLY payment and TOTAL PAYBACK shown together: $250,000 — $4,006/wk — $312,500 total — 18-month; $150,000 — $2,404/wk — $187,500 total — 18-month; $100,000 — $1,603/wk — $125,000 total — 18-month; $75,000 — $1,442/wk — $93,750 total — 15-month; $50,000 — $962/wk — $62,500 total — 15-month; $25,000 — $601/wk — $31,250 total — 12-month; $15,000 — $721/wk — $18,750 total — 6-month. Pick the tiers that fit the layout (premium → top three; small-business grids → a spread). ALWAYS include the catch-all 'Any amount up to $500,000 — apply to get quoted' and the disclaimer 'Figures are illustrative at a 1.25 factor rate; your actual amount, term, and payment are confirmed at quote and subject to underwriting approval.' COMPLIANCE: never claim 'no credit pull/check' (unconfirmed); state eligibility as '$15,000+ in monthly revenue, 6+ months in business, U.S. business checking account'. Mirror the canonical markup/branding from a tier template such as business_capital_tiers.html.",
  ].join("\n");
}

function TemplateCard({
  template,
  onPreview,
}: {
  template: TemplateMeta;
  onPreview: (template: TemplateMeta) => void;
}) {
  const [copied, setCopied] = useState(false);
  const category = CATEGORY_META[template.category];

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      await copyToClipboard(template.html);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    },
    [template.html],
  );

  return (
    <Card className="h-full hover:border-accent/40">
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent-muted/30 bg-accent-soft text-accent">
            <Mail className="h-4 w-4" />
          </div>
          <Tag tone="accent">{category.label}</Tag>
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold leading-snug text-fg">{template.name}</h2>
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-fg-muted">
            <span className="font-semibold text-fg-dim">Subject:</span> {template.subject}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-fg-dim">
            {category.description}
          </p>
        </div>

        <div className="space-y-2 border-t border-bg-border pt-3">
          <div className="flex flex-wrap gap-1.5">
            {template.tokens.slice(0, 5).map((token) => (
              <code
                key={token}
                className="rounded-md border border-bg-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
              >
                {`{{${token}}}`}
              </code>
            ))}
            {template.tokens.length > 5 && (
              <span className="rounded-md border border-bg-border bg-bg-deep px-1.5 py-0.5 text-[10px] text-fg-dim">
                +{template.tokens.length - 5}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-fg-dim">
              {template.key} - {template.sizeKb} KB
            </span>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2 py-1 text-[10px] font-bold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => onPreview(template)}
                className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[10px] font-bold text-accent transition-colors hover:bg-accent/20"
              >
                <Eye className="h-3 w-3" />
                Preview
              </button>
              <Link
                href={agentHref("helios", buildUseWithAgentPrompt(template))}
                className="inline-flex items-center gap-1 rounded-md border border-status-engaged/30 bg-status-engaged/10 px-2 py-1 text-[10px] font-bold text-status-engaged transition-colors hover:bg-status-engaged/20"
              >
                <Send className="h-3 w-3" />
                Use with Helios
              </Link>
            </div>
          </div>
          <Link
            href={agentHref("solara", buildCreateHtmlPrompt(template))}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-status-warm/30 bg-status-warm/10 px-2 py-1.5 text-[10px] font-bold text-status-warm transition-colors hover:bg-status-warm/20"
          >
            <WandSparkles className="h-3 w-3" />
            Ask Solara for variant
          </Link>
        </div>
      </div>
    </Card>
  );
}

function PreviewModal({
  template,
  onClose,
}: {
  template: TemplateMeta;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "html">("preview");
  const previewHtml = useMemo(() => renderPreviewHtml(template), [template]);

  useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(template.html);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [template.html]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-deep/95 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-preview-title"
    >
      <div className="flex h-[94vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-lg border border-bg-border bg-bg-panel shadow-2xl">
        <header className="flex flex-col gap-3 border-b border-bg-border bg-bg-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent-muted/30 bg-accent-soft text-accent">
              <Mail className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div id="template-preview-title" className="truncate text-sm font-bold text-fg">
                {template.name}
              </div>
              <div className="truncate text-[11px] text-fg-dim">{template.subject}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-bg-border">
              <button
                type="button"
                onClick={() => setViewMode("preview")}
                className={`px-3 py-1.5 text-[11px] font-bold transition-colors ${
                  viewMode === "preview"
                    ? "bg-accent/15 text-accent"
                    : "bg-bg-elev text-fg-muted hover:text-fg"
                }`}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setViewMode("html")}
                className={`border-l border-bg-border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                  viewMode === "html"
                    ? "bg-accent/15 text-accent"
                    : "bg-bg-elev text-fg-muted hover:text-fg"
                }`}
              >
                HTML
              </button>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-3 py-1.5 text-[11px] font-bold text-accent transition-colors hover:bg-accent/20"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy HTML"}
            </button>
            <Link
              href={agentHref("helios", buildUseWithAgentPrompt(template))}
              className="inline-flex items-center gap-1.5 rounded-md border border-status-engaged/30 bg-status-engaged/10 px-3 py-1.5 text-[11px] font-bold text-status-engaged transition-colors hover:bg-status-engaged/20"
            >
              <Send className="h-3.5 w-3.5" />
              Use with Helios
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-fg-muted transition-colors hover:border-accent/40 hover:text-fg"
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          {viewMode === "preview" ? (
            <div className="h-full min-h-[620px] bg-[#071226]">
              <iframe
                title={`Preview: ${template.name}`}
                srcDoc={previewHtml}
                sandbox=""
                className="h-full w-full border-0 bg-[#071226]"
              />
            </div>
          ) : (
            <pre className="min-h-full overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[11px] leading-relaxed text-fg-muted">
              {template.html}
            </pre>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-bg-border px-4 py-3 text-[10px] text-fg-dim sm:flex-row sm:items-center sm:justify-between">
          <span>
            Key: <code className="font-mono text-accent/80">{template.key}</code>
          </span>
          <span className="flex flex-wrap gap-1">
            {template.tokens.map((token) => (
              <code key={token} className="font-mono text-fg-muted">
                {`{{${token}}}`}
              </code>
            ))}
          </span>
        </footer>
      </div>
    </div>
  );
}

export default function TemplatesPage() {
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateMeta | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const templates = useMemo<TemplateMeta[]>(
    () =>
      COLD_OUTREACH_TEMPLATES.map((template) => ({
        ...template,
        category: inferCategory(template.key),
        sizeKb: Math.max(1, Math.round(template.html.length / 1024)),
        tokens: extractTokens(template.html),
        sourcePath: `lib/cold-outreach/templates/${template.key}.html`,
      })),
    [],
  );

  const allTokens = useMemo(
    () => [...new Set(templates.flatMap((template) => template.tokens))].sort(),
    [templates],
  );

  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<
      Category,
      number
    >;
    for (const template of templates) {
      counts.all += 1;
      counts[template.category] += 1;
    }
    return counts;
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return templates.filter((template) => {
      if (activeCategory !== "all" && template.category !== activeCategory) return false;
      if (!query) return true;
      return (
        template.name.toLowerCase().includes(query) ||
        template.subject.toLowerCase().includes(query) ||
        template.key.toLowerCase().includes(query) ||
        template.tokens.some((token) => token.toLowerCase().includes(query))
      );
    });
  }, [activeCategory, searchQuery, templates]);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Template Library"
        subtitle="SunBiz HTML emails Ezra can preview, copy, send with Helios, or hand to Solara for a new variant."
        action={<Tag tone="engaged">{templates.length} HTML assets</Tag>}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/playbook"
          className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elev px-3 py-1.5 text-xs font-bold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Playbook
        </Link>
        <Link
          href={agentHref("solara", buildCreateHtmlPrompt())}
          className="inline-flex items-center gap-1.5 rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-1.5 text-xs font-bold text-status-warm transition-colors hover:bg-status-warm/20"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          New HTML with Solara
        </Link>
        <Tag tone="accent">preview before send</Tag>
        <Tag tone="warm">unsubscribe required</Tag>
      </div>

      <section className="rounded-lg border border-bg-border bg-bg-panel p-4 shadow-sm">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-3 min-w-0">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-dim" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label="Search email templates"
                placeholder="Search name, subject, key, or variable..."
                className="w-full rounded-lg border border-bg-border bg-bg-deep py-2 pl-9 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_ORDER.filter((category) => categoryCounts[category] > 0).map((category) => {
                const active = category === activeCategory;
                return (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setActiveCategory(category)}
                    title={CATEGORY_META[category].description}
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                      active
                        ? "border-accent/50 bg-accent/15 text-accent"
                        : "border-bg-border bg-bg-elev text-fg-muted hover:border-accent/30 hover:text-fg"
                    }`}
                  >
                    {CATEGORY_META[category].label} ({categoryCounts[category]})
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-md border border-bg-border bg-bg-deep p-3">
            <div className="flex items-center gap-2 text-xs font-bold text-fg">
              <Braces className="h-3.5 w-3.5 text-accent" />
              Merge fields in use
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {allTokens.map((token) => (
                <code
                  key={token}
                  className="rounded-md border border-bg-border bg-bg-panel px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
                >
                  {`{{${token}}}`}
                </code>
              ))}
            </div>
          </div>
        </div>
      </section>

      {filteredTemplates.length === 0 ? (
        <Card>
          <div className="py-12 text-center">
            <FileCode2 className="mx-auto mb-3 h-8 w-8 text-fg-dim" />
            <p className="text-sm text-fg-muted">
              No templates match that search or category.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredTemplates.map((template) => (
            <TemplateCard
              key={template.key}
              template={template}
              onPreview={setSelectedTemplate}
            />
          ))}
        </div>
      )}

      <div className="text-center text-[11px] text-fg-dim">
        Showing {filteredTemplates.length} of {templates.length} templates.
      </div>

      {selectedTemplate && (
        <PreviewModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
        />
      )}
    </div>
  );
}
