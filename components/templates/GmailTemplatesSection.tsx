"use client";

/**
 * Gmail Templates — the plain-text sibling of the HTML template library.
 *
 * DB-backed CRUD (gmail_templates) with stage categorization, copy/preview
 * controls adapted for plain text, and Solara-generated copy variants
 * attached to each base template. All mutations sync local state from the
 * server response — no hard refresh anywhere.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Card, EmptyState, Tag } from "@/components/Card";
import {
  createGmailTemplate,
  deleteGmailTemplate,
  extractGmailTokens,
  generateSolaraVariant,
  gmailStageLabel,
  GMAIL_TEMPLATE_STAGES,
  containsHtml,
  listGmailTemplates,
  renderGmailTemplate,
  updateGmailTemplate,
  type GmailTemplate,
} from "@/lib/gmail-templates";
import {
  Check,
  Copy,
  Eye,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";

/** Sample merge values for the plain-text preview/personalize flow (kept in
 *  lockstep with the HTML library's samples). */
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
};

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt("Copy this text:", text);
  }
}

function ActionButton({
  onClick,
  tone = "neutral",
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  tone?: "neutral" | "accent" | "warm" | "engaged" | "danger";
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral:
      "border-bg-border bg-bg-elev text-fg-muted hover:border-accent/40 hover:text-fg",
    accent: "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20",
    warm: "border-status-warm/30 bg-status-warm/10 text-status-warm hover:bg-status-warm/20",
    engaged:
      "border-status-engaged/30 bg-status-engaged/10 text-status-engaged hover:bg-status-engaged/20",
    danger: "border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

// ── Editor modal (create / edit) ───────────────────────────────────────────

function EditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: GmailTemplate | null;
  onClose: () => void;
  onSaved: (t: GmailTemplate) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [stage, setStage] = useState(initial?.stage ?? "general");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; hits?: string[] } | null>(null);

  const htmlProblem = containsHtml(subject) || containsHtml(body);
  const tokens = useMemo(() => extractGmailTokens(`${subject}\n${body}`), [subject, body]);
  const canSave = name.trim().length > 0 && body.trim().length > 0 && !htmlProblem && !saving;

  useEffect(() => {
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prior;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setServerError(null);
    const res = initial
      ? await updateGmailTemplate(initial.id, { name, stage, subject, body })
      : await createGmailTemplate({ name, stage, subject, body });
    setSaving(false);
    if (res.ok) {
      onSaved(res.template);
      onClose();
      return;
    }
    setServerError({
      message:
        res.message ||
        (res.error === "html_not_allowed"
          ? "HTML is not allowed in Gmail templates."
          : `Save failed: ${res.error}`),
      hits: res.hits,
    });
  }, [initial, name, stage, subject, body, onSaved, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-deep/95 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[94vh] w-full max-w-[720px] flex-col overflow-hidden rounded-lg border border-bg-border bg-bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-bold text-fg">
            <MessageSquareText className="h-4 w-4 text-accent" />
            {initial ? "Edit Gmail template" : "New Gmail template"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-fg-muted transition-colors hover:text-fg"
            aria-label="Close editor"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Follow-up nudge, short"
                className="rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">Pipeline stage</span>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                className="rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-sm text-fg outline-none transition-colors focus:border-accent/50"
              >
                {GMAIL_TEMPLATE_STAGES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Quick question about {{business_name}}"
              className="rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              Body — plain text, Gmail-ready
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder={"Hi {{first_name}},\n\nSaw {{business_name}} and wanted to reach out..."}
              className="rounded-md border border-bg-border bg-bg-deep px-3 py-2 font-mono text-xs leading-relaxed text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
            />
          </label>

          <div className="flex flex-wrap items-center gap-1.5">
            {tokens.map((token) => (
              <code
                key={token}
                className="rounded-md border border-bg-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
              >
                {`{{${token}}}`}
              </code>
            ))}
            {tokens.length === 0 && (
              <span className="text-[10px] text-fg-dim">
                Tip: {"{{first_name}}"} and {"{{business_name}}"} merge automatically at send time.
              </span>
            )}
          </div>

          {htmlProblem && (
            <p className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              HTML tags detected — Gmail templates are strictly plain text. Paste the text version instead.
            </p>
          )}
          {serverError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {serverError.message}
              {serverError.hits && serverError.hits.length > 0 && (
                <span className="mt-1 block font-mono text-[11px]">
                  Flagged: {serverError.hits.join(", ")}
                </span>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-bg-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[11px] font-bold text-fg-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/15 px-3 py-1.5 text-[11px] font-bold text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {initial ? "Save changes" : "Create template"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ── Preview modal (base + variants, personalize, copy) ─────────────────────

function PreviewModal({
  template,
  onClose,
  onTemplateChange,
}: {
  template: GmailTemplate;
  onClose: () => void;
  onTemplateChange: (t: GmailTemplate) => void;
}) {
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);
  const [guidance, setGuidance] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const variants = useMemo(() => template.variants ?? [], [template.variants]);
  const active: { subject: string; body: string; label: string } = useMemo(() => {
    const v = variants.find((x) => x.id === activeVariantId);
    return v
      ? { subject: v.subject, body: v.body, label: v.label }
      : { subject: template.subject, body: template.body, label: "Base template" };
  }, [variants, activeVariantId, template]);

  const tokens = useMemo(
    () => extractGmailTokens(`${active.subject}\n${active.body}`),
    [active],
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const merged = useMemo(() => {
    const values = Object.fromEntries(
      tokens.map((t) => [t, fields[t] || SAMPLE_VALUES[t] || ""]),
    );
    return {
      subject: renderGmailTemplate(active.subject, values),
      body: renderGmailTemplate(active.body, values),
    };
  }, [active, tokens, fields]);

  useEffect(() => {
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prior;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const handleCopy = useCallback(
    async (what: "subject" | "body") => {
      await copyText(what === "subject" ? merged.subject : merged.body);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1800);
    },
    [merged],
  );

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    const res = await generateSolaraVariant(template.id, guidance);
    setGenerating(false);
    if (res.ok) {
      onTemplateChange(res.template);
      setActiveVariantId(res.variant.id);
      setGuidance("");
    } else {
      setGenError(res.message || res.error);
    }
  }, [template.id, guidance, onTemplateChange]);

  const handleRemoveVariant = useCallback(
    async (variantId: string) => {
      setRemovingId(variantId);
      const res = await updateGmailTemplate(template.id, { removeVariantId: variantId });
      setRemovingId(null);
      if (res.ok) {
        onTemplateChange(res.template);
        if (activeVariantId === variantId) setActiveVariantId(null);
      }
    },
    [template.id, activeVariantId, onTemplateChange],
  );

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-deep/95 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[94vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-lg border border-bg-border bg-bg-panel shadow-2xl">
        <header className="flex flex-col gap-2 border-b border-bg-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent-muted/30 bg-accent-soft text-accent">
              <MessageSquareText className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-fg">{template.name}</div>
              <div className="truncate text-[11px] text-fg-dim">
                {gmailStageLabel(template.stage)} · {active.label}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton onClick={() => handleCopy("subject")} tone="neutral">
              {copied === "subject" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied === "subject" ? "Copied" : "Copy subject"}
            </ActionButton>
            <ActionButton onClick={() => handleCopy("body")} tone="accent">
              {copied === "body" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied === "body" ? "Copied" : "Copy body"}
            </ActionButton>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-fg-muted transition-colors hover:text-fg"
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Variant rail */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-bg-border bg-bg-deep/40 px-4 py-2">
          <button
            type="button"
            onClick={() => setActiveVariantId(null)}
            className={`rounded-full border px-3 py-1 text-[11px] font-bold transition-colors ${
              activeVariantId === null
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-bg-border bg-bg-elev text-fg-muted hover:text-fg"
            }`}
          >
            Base
          </button>
          {variants.map((v) => (
            <span key={v.id} className="inline-flex items-center">
              <button
                type="button"
                onClick={() => setActiveVariantId(v.id)}
                className={`rounded-l-full border px-3 py-1 text-[11px] font-bold transition-colors ${
                  activeVariantId === v.id
                    ? "border-status-warm/50 bg-status-warm/15 text-status-warm"
                    : "border-bg-border bg-bg-elev text-fg-muted hover:text-fg"
                }`}
                title={`Solara variant · ${new Date(v.created_at).toLocaleDateString()}`}
              >
                <WandSparkles className="mr-1 inline h-3 w-3" />
                {v.label}
              </button>
              <button
                type="button"
                onClick={() => handleRemoveVariant(v.id)}
                disabled={removingId === v.id}
                className="rounded-r-full border border-l-0 border-bg-border bg-bg-elev px-1.5 py-1 text-fg-dim transition-colors hover:text-red-300 disabled:opacity-40"
                aria-label={`Delete variant ${v.label}`}
              >
                {removingId === v.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
              </button>
            </span>
          ))}
          <span className="ml-auto flex items-center gap-1.5">
            <input
              type="text"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="Optional guidance for Solara..."
              className="w-44 rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-status-warm/50"
            />
            <ActionButton onClick={handleGenerate} tone="warm" disabled={generating}>
              {generating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <WandSparkles className="h-3 w-3" />
              )}
              {generating ? "Solara is writing..." : "Add Solara Variant"}
            </ActionButton>
          </span>
        </div>
        {genError && (
          <p className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200">
            Solara variant failed: {genError}
          </p>
        )}

        {/* Personalize */}
        {tokens.length > 0 && (
          <div className="shrink-0 border-b border-bg-border bg-bg-deep/40 px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              <WandSparkles className="h-3 w-3 text-accent" />
              Personalize — fill in the merchant, then copy
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {tokens.map((token) => (
                <label key={token} className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold capitalize text-fg-muted">
                    {token.replace(/_/g, " ")}
                  </span>
                  <input
                    type="text"
                    value={fields[token] ?? ""}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, [token]: e.target.value }))
                    }
                    placeholder={SAMPLE_VALUES[token] ?? token}
                    className="rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-xs text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Plain-text preview — rendered exactly as Gmail will show it */}
        <div className="min-h-0 flex-1 overflow-auto bg-bg-deep/60 p-5">
          <div className="mx-auto max-w-[640px] rounded-lg border border-bg-border bg-bg-panel p-5">
            <div className="border-b border-bg-border pb-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">Subject</span>
              <p className="mt-1 text-sm font-semibold text-fg">
                {merged.subject || <span className="text-fg-dim">(no subject)</span>}
              </p>
            </div>
            <pre className="mt-4 whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-fg-muted">
              {merged.body}
            </pre>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

function GmailTemplateCard({
  template,
  onPreview,
  onEdit,
  onDelete,
  onTemplateChange,
}: {
  template: GmailTemplate;
  onPreview: (t: GmailTemplate) => void;
  onEdit: (t: GmailTemplate) => void;
  onDelete: (t: GmailTemplate) => void;
  onTemplateChange: (t: GmailTemplate) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const tokens = useMemo(
    () => extractGmailTokens(`${template.subject}\n${template.body}`),
    [template],
  );

  const handleCopy = useCallback(async () => {
    await copyText(template.body);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [template.body]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    const res = await generateSolaraVariant(template.id);
    setGenerating(false);
    if (res.ok) onTemplateChange(res.template);
    else setGenError(res.message || res.error);
  }, [template.id, onTemplateChange]);

  return (
    <Card className="h-full hover:border-accent/40">
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent-muted/30 bg-accent-soft text-accent">
            <MessageSquareText className="h-4 w-4" />
          </div>
          <Tag tone="accent">{gmailStageLabel(template.stage)}</Tag>
          {template.variants.length > 0 && (
            <Tag tone="warm">
              {template.variants.length} Solara variant{template.variants.length > 1 ? "s" : ""}
            </Tag>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold leading-snug text-fg">{template.name}</h2>
          <p className="mt-1.5 line-clamp-1 text-xs leading-relaxed text-fg-muted">
            <span className="font-semibold text-fg-dim">Subject:</span>{" "}
            {template.subject || "(none)"}
          </p>
          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-fg-dim">
            {template.body}
          </p>
        </div>

        <div className="space-y-2 border-t border-bg-border pt-3">
          <div className="flex flex-wrap gap-1.5">
            {tokens.slice(0, 5).map((token) => (
              <code
                key={token}
                className="rounded-md border border-bg-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
              >
                {`{{${token}}}`}
              </code>
            ))}
            {tokens.length > 5 && (
              <span className="rounded-md border border-bg-border bg-bg-deep px-1.5 py-0.5 text-[10px] text-fg-dim">
                +{tokens.length - 5}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ActionButton onClick={handleCopy} tone="neutral">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </ActionButton>
            <ActionButton onClick={() => onPreview(template)} tone="accent">
              <Eye className="h-3 w-3" />
              Preview
            </ActionButton>
            <ActionButton onClick={() => onEdit(template)} tone="neutral" title="Edit">
              <Pencil className="h-3 w-3" />
              Edit
            </ActionButton>
            {confirmingDelete ? (
              <>
                <ActionButton onClick={() => onDelete(template)} tone="danger">
                  <Trash2 className="h-3 w-3" />
                  Confirm
                </ActionButton>
                <ActionButton onClick={() => setConfirmingDelete(false)} tone="neutral">
                  Cancel
                </ActionButton>
              </>
            ) : (
              <ActionButton onClick={() => setConfirmingDelete(true)} tone="neutral" title="Delete">
                <Trash2 className="h-3 w-3" />
              </ActionButton>
            )}
          </div>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-status-warm/30 bg-status-warm/10 px-2 py-1.5 text-[10px] font-bold text-status-warm transition-colors hover:bg-status-warm/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <WandSparkles className="h-3 w-3" />
            )}
            {generating ? "Solara is writing..." : "Add Solara Variant"}
          </button>
          {genError && <p className="text-[10px] text-red-300">{genError}</p>}
        </div>
      </div>
    </Card>
  );
}

// ── Section ────────────────────────────────────────────────────────────────

export default function GmailTemplatesSection() {
  const [templates, setTemplates] = useState<GmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [editing, setEditing] = useState<{ template: GmailTemplate | null } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listGmailTemplates();
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setTemplates(res.templates);
      else setLoadError(res.message || res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Insert-or-replace a template in local state — every mutation syncs the
   *  server's row back in, so the UI is fresh without a reload. */
  const upsertTemplate = useCallback((t: GmailTemplate) => {
    setTemplates((prev) => {
      const idx = prev.findIndex((x) => x.id === t.id);
      if (idx === -1) return [t, ...prev];
      const next = [...prev];
      next[idx] = t;
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (t: GmailTemplate) => {
    setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    const res = await deleteGmailTemplate(t.id);
    if (!res.ok) {
      // Restore on failure — the delete didn't land.
      setTemplates((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
      setLoadError(res.message || `Delete failed: ${res.error}`);
    }
  }, []);

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: templates.length };
    for (const t of templates) counts[t.stage] = (counts[t.stage] ?? 0) + 1;
    return counts;
  }, [templates]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return templates.filter((t) => {
      if (activeStage !== "all" && t.stage !== activeStage) return false;
      if (!query) return true;
      return (
        t.name.toLowerCase().includes(query) ||
        t.subject.toLowerCase().includes(query) ||
        t.body.toLowerCase().includes(query)
      );
    });
  }, [templates, activeStage, searchQuery]);

  const previewTemplate = previewId
    ? templates.find((t) => t.id === previewId) ?? null
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing({ template: null })}
          className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent/25"
        >
          <Plus className="h-3.5 w-3.5" />
          New Gmail template
        </button>
        <Tag tone="accent">plain text only</Tag>
        <Tag tone="warm">Solara writes the variants</Tag>
        <Tag tone="engaged">{templates.length} templates</Tag>
      </div>

      <section className="rounded-lg border border-bg-border bg-bg-panel p-4 shadow-sm">
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search Gmail templates"
              placeholder="Search name, subject, or body..."
              className="w-full rounded-lg border border-bg-border bg-bg-deep py-2 pl-9 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              Pipeline stage
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[{ key: "all", label: "All" }, ...GMAIL_TEMPLATE_STAGES].map((s) => {
                const count = stageCounts[s.key] ?? 0;
                if (s.key !== "all" && s.key !== activeStage && count === 0) return null;
                const active = s.key === activeStage;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setActiveStage(s.key)}
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                      active
                        ? "border-accent/50 bg-accent/15 text-accent"
                        : "border-bg-border bg-bg-elev text-fg-muted hover:border-accent/30 hover:text-fg"
                    }`}
                  >
                    {s.label} ({count})
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {loadError && (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {loadError}
        </p>
      )}

      {loading ? (
        <Card>
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Gmail templates...
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            message={
              templates.length === 0
                ? "No Gmail templates yet — create the first one, or have Solara draft variants once a base exists."
                : "No templates match that stage or search."
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((template) => (
            <GmailTemplateCard
              key={template.id}
              template={template}
              onPreview={(t) => setPreviewId(t.id)}
              onEdit={(t) => setEditing({ template: t })}
              onDelete={handleDelete}
              onTemplateChange={upsertTemplate}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditorModal
          initial={editing.template}
          onClose={() => setEditing(null)}
          onSaved={upsertTemplate}
        />
      )}
      {previewTemplate && (
        <PreviewModal
          template={previewTemplate}
          onClose={() => setPreviewId(null)}
          onTemplateChange={upsertTemplate}
        />
      )}
    </div>
  );
}
