"use client";

/**
 * SunBizFormsClient — SunBiz-specific Forms surface for /forms (Phase 3.4).
 *
 * Renders three prominent step cards at the top (Initial Lead Capture,
 * Full Application, Bank Statement Upload), each showing a status pill
 * and quick-action buttons. Below the cards: any other forms for this
 * tenant that don't match the three SunBiz slugs ("Other forms").
 *
 * Detection: a form IS a SunBiz step iff its slug matches one of the
 * three canonical slugs below. If an operator edits the slug in the
 * form editor to something else, the form silently drops from the step
 * group and appears under "Other forms" instead — by design.
 *
 * Wired into app/forms/page.tsx when tenant slug === "sun".
 */

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  LEAD_SOURCE_CHANNELS,
  LEAD_SOURCE_LABELS,
  withLeadSourceParam,
} from "@/lib/forms/lead-source";
import {
  FileText,
  CheckCircle2,
  AlertCircle,
  Edit3,
  Eye,
  Copy,
  Sparkles,
  Loader2,
  Check,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FormRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type SunBizStepSlug =
  | "initial-lead-capture"
  | "full-application"
  | "bank-statement-upload";

type StepSpec = {
  slug: SunBizStepSlug;
  stepNumber: 1 | 2 | 3;
  title: string;
  description: string;
};

// ---------------------------------------------------------------------------
// Step spec — source of truth for ordering + display copy
// ---------------------------------------------------------------------------

const STEP_SPECS: StepSpec[] = [
  {
    slug: "initial-lead-capture",
    stepNumber: 1,
    title: "Initial Lead Capture",
    description:
      "First touch. Captures business name, contact, phone, email, and a one-line note. Sent via personalized link.",
  },
  {
    slug: "full-application",
    stepNumber: 2,
    title: "Full Application",
    description:
      "Comprehensive application. All the fields a lender needs — business identity, owner info, financials, and document uploads.",
  },
  {
    slug: "bank-statement-upload",
    stepNumber: 3,
    title: "Bank Statement Upload",
    description:
      "Lightweight follow-up form for any lead missing statements. Just 3 file slots + a confirmation checkbox.",
  },
];

const SUNBIZ_SLUGS: Set<string> = new Set(STEP_SPECS.map((s) => s.slug));

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

type PillState = "active" | "disabled" | "missing";

function StatusPill({ state }: { state: PillState }) {
  if (state === "active") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400">
        <CheckCircle2 className="w-3 h-3" />
        Active
      </span>
    );
  }
  if (state === "disabled") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400">
        <AlertCircle className="w-3 h-3" />
        Not configured
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/15 text-red-400">
      <AlertCircle className="w-3 h-3" />
      Missing — create now
    </span>
  );
}

// ---------------------------------------------------------------------------
// Step card
// ---------------------------------------------------------------------------

function StepCard({
  spec,
  form,
  tenantSlug,
  onCreateSuccess,
}: {
  spec: StepSpec;
  form: FormRow | null;
  tenantSlug: string | null;
  onCreateSuccess: (slug: string, formId: string) => void;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Prevent double-fire on "Create from template"
  const inFlightRef = useRef(false);

  const pillState: PillState = !form ? "missing" : form.enabled ? "active" : "disabled";

  const handleCreate = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(`/api/forms/templates/sunbiz/${spec.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const data = (await res.json()) as {
        ok: boolean;
        form_id?: string;
        error?: string;
        hint?: string;
      };

      if (res.status === 409 && data.form_id) {
        // Form already exists — navigate to its editor
        router.push(`/forms/${data.form_id}/edit`);
        return;
      }
      if (!data.ok || !data.form_id) {
        setCreateError(data.hint ?? data.error ?? `http_${res.status}`);
        return;
      }
      onCreateSuccess(spec.slug, data.form_id);
      router.push(`/forms/${data.form_id}/edit`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "network_error");
    } finally {
      setCreating(false);
      inFlightRef.current = false;
    }
  }, [spec.slug, router, onCreateSuccess]);

  return (
    <>
      <div className="rounded-xl border border-bg-border bg-bg-panel shadow-card p-5 space-y-4">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
            <FileText className="w-4 h-4 text-accent" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
                Step {spec.stepNumber}
              </span>
              <StatusPill state={pillState} />
            </div>
            <div className="mt-0.5 font-bold text-fg text-sm">{spec.title}</div>
          </div>
        </div>

        {/* Description */}
        <div className="text-xs text-fg-muted leading-relaxed">{spec.description}</div>

        {/* Error */}
        {createError && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-400">
            {createError}
          </div>
        )}

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {form ? (
            <>
              <Link
                href={`/forms/${form.id}/edit`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-bg-elev border border-bg-border text-fg-muted hover:text-fg hover:border-accent/40 px-3 py-1.5 text-xs font-bold transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Open form editor
              </Link>

              {tenantSlug && (
                <a
                  href={`/f/${tenantSlug}/${spec.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-bg-elev border border-bg-border text-fg-muted hover:text-fg hover:border-accent/40 px-3 py-1.5 text-xs font-bold transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Preview live form
                </a>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent text-bg-deep px-3 py-1.5 text-xs font-bold hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              Create from template
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-agent interest links
// ---------------------------------------------------------------------------

// The SunBiz roster. rep keys are validated server-side against tenant members
// (lib/forms/agent-routing.ts resolveRepAssignment) — these are just the
// operator-facing labels for the copyable links. A new agent works the moment
// they have a user_profiles row; add a row here to surface their link.
const SUNBIZ_AGENTS: Array<{ key: string; label: string }> = [
  { key: "jordan", label: "Jordan" },
  { key: "alex", label: "Alex" },
  { key: "matt", label: "Matt" },
];

function PerAgentLinksCard({
  tenantSlug,
  interestForm,
}: {
  tenantSlug: string | null;
  interestForm: FormRow | null;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  if (!tenantSlug || !interestForm) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // No ?rep= on purpose: this is the shared-template link.
  const universalEmailUrl = withLeadSourceParam(
    `${origin}/f/${tenantSlug}/${interestForm.slug}`,
    "email",
  );

  async function copy(key: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  return (
    <section className="space-y-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
        Per-agent interest links
      </div>
      <div className="rounded-xl border border-bg-border bg-bg-panel shadow-card p-5 space-y-3">
        <div className="text-xs text-fg-muted leading-relaxed">
          Share each agent&apos;s own link to the Initial Lead Capture form. A submission lands in the
          Opportunity Pipeline <strong className="text-fg">assigned to that agent</strong>, and the
          Inquiry Welcomer drip texts + emails the applicant the full application — signed by them.
          {" "}Each agent gets <strong className="text-fg">three</strong> links: send the Text one
          in an SMS blast, read the Dial one out on a call, paste the Email one into an email.
          Whichever they use tags the lead, and the split shows up under Metrics — Lead
          Origination. A link without the tag still works, it just counts as Unknown.
          {!interestForm.enabled && (
            <span className="text-amber-400">
              {" "}
              Heads up: the Initial Lead Capture form is currently disabled — enable it (open the
              editor above) before sharing these links.
            </span>
          )}
        </div>
        <div className="space-y-4">
          {SUNBIZ_AGENTS.map((a) => {
            // ?rep= routes the lead to the agent; ?source= tags how it came in.
            // Orthogonal on purpose — the same agent works both channels — so
            // every agent gets one link per channel off a shared base.
            const base = `${origin}/f/${tenantSlug}/${interestForm.slug}?rep=${a.key}`;
            return (
              <div key={a.key} className="space-y-1.5">
                <div className="text-sm font-bold text-fg">{a.label}</div>
                {LEAD_SOURCE_CHANNELS.map((channel) => {
                  const url = withLeadSourceParam(base, channel);
                  const copyKey = `${a.key}:${channel}`;
                  return (
                    <div key={channel} className="flex items-center gap-2">
                      <span
                        className={`w-12 shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] ${
                          channel === "text"
                            ? "text-accent"
                            : channel === "dial"
                              ? "text-status-engaged"
                              : "text-[#a855f7]"
                        }`}
                      >
                        {LEAD_SOURCE_LABELS[channel]}
                      </span>
                      <code className="flex-1 truncate rounded-md bg-bg-deep border border-bg-border px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
                        {url}
                      </code>
                      <button
                        type="button"
                        onClick={() => copy(copyKey, url)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-bg-elev border border-bg-border text-fg-muted hover:text-fg hover:border-accent/40 px-3 py-1.5 text-xs font-bold transition-colors"
                      >
                        {copiedKey === copyKey ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            Copy
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Universal email link — Adon 2026-08-24: "this could just be one
            universal link that is used for any leads that we send an
            application through email to". Carries the channel tag but no rep,
            so it is the right thing to paste into a shared email template or
            anywhere the sender is not one specific agent. A lead from it is
            attributed to Email and lands unassigned, exactly as an untagged
            shared link does today. */}
        <div className="mt-4 space-y-1.5 border-t border-bg-border pt-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            Universal email link (no rep)
          </div>
          <div className="text-xs leading-relaxed text-fg-dim">
            For shared email templates and anywhere the sender is not one specific agent. Counts as
            Email, lands unassigned. Use an agent&apos;s own Email link above when you want the lead
            to land under their name.
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="w-12 shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-[#a855f7]">
              Email
            </span>
            <code className="flex-1 truncate rounded-md bg-bg-deep border border-bg-border px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
              {universalEmailUrl}
            </code>
            <button
              type="button"
              onClick={() => copy("universal:email", universalEmailUrl)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-bg-elev border border-bg-border text-fg-muted hover:text-fg hover:border-accent/40 px-3 py-1.5 text-xs font-bold transition-colors"
            >
              {copiedKey === "universal:email" ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function SunBizFormsClient({
  initialRows,
  tenantSlug,
}: {
  initialRows: FormRow[];
  tenantSlug: string | null;
}) {
  const [rows, setRows] = useState(initialRows);

  // Build a slug → form map for O(1) step lookups
  const slugMap = new Map(rows.map((r) => [r.slug, r]));

  // "Other forms" = anything that doesn't match a SunBiz step slug
  const otherForms = rows.filter((r) => !SUNBIZ_SLUGS.has(r.slug));

  function handleCreateSuccess(slug: string, formId: string) {
    // Optimistically add the newly-created form to the rows state so the
    // step card immediately shows "Active" if the user navigates back here.
    setRows((prev) => {
      if (prev.some((r) => r.id === formId)) return prev;
      const now = new Date().toISOString();
      return [
        ...prev,
        {
          id: formId,
          slug,
          name: STEP_SPECS.find((s) => s.slug === slug)?.title ?? slug,
          description: null,
          enabled: true,
          created_at: now,
          updated_at: now,
        },
      ];
    });
  }

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Three-step funnel cards                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
          SunBiz application funnel
        </div>
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-3">
          {STEP_SPECS.map((spec) => (
            <StepCard
              key={spec.slug}
              spec={spec}
              form={slugMap.get(spec.slug) ?? null}
              tenantSlug={tenantSlug}
              onCreateSuccess={handleCreateSuccess}
            />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Per-agent interest links                                             */}
      {/* ------------------------------------------------------------------ */}
      <PerAgentLinksCard
        tenantSlug={tenantSlug}
        interestForm={slugMap.get("initial-lead-capture") ?? null}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Other forms                                                          */}
      {/* ------------------------------------------------------------------ */}
      {otherForms.length > 0 && (
        <section className="space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            Other forms
          </div>
          <div className="overflow-x-auto rounded-xl border border-bg-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-elev/50">
                <tr className="text-left text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-4 py-2 font-bold">Name</th>
                  <th className="px-4 py-2 font-bold">Slug</th>
                  <th className="px-4 py-2 font-bold">Status</th>
                  <th className="px-4 py-2 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {otherForms.map((r) => (
                  <tr key={r.id} className="hover:bg-bg-elev/30">
                    <td className="px-4 py-3">
                      <div className="font-bold text-fg">{r.name}</div>
                      {r.description && (
                        <div className="text-xs text-fg-muted truncate max-w-md">
                          {r.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                      {r.slug}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill state={r.enabled ? "active" : "disabled"} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/forms/${r.id}/edit`}
                        className="inline-flex items-center gap-1 text-accent hover:text-accent-bright text-xs"
                      >
                        <Edit3 className="w-3 h-3" />
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Empty state when no other forms */}
      {otherForms.length === 0 && rows.some((r) => SUNBIZ_SLUGS.has(r.slug)) && (
        <div className="text-xs text-fg-dim">
          All forms are part of the SunBiz funnel above.
        </div>
      )}
    </div>
  );
}
