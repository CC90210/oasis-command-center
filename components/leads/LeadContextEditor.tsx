"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Save } from "lucide-react";
import { safeExternalUrl } from "@/lib/web-leads/url-safety";

type FormState = {
  name: string;
  company: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  business_city: string;
  state: string;
  website_condition: string;
  audit_findings: string;
  notes: string;
  next_action_at: string;
};

type Props = {
  leadId: string;
  tenantSlug: string;
  initial: Record<string, unknown>;
};

const INPUT =
  "w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/70 focus:ring-1 focus:ring-accent/30";

export function LeadContextEditor({ leadId, tenantSlug, initial }: Props) {
  const router = useRouter();
  const [refreshPending, startTransition] = useTransition();
  const [state, setState] = useState<FormState>(() => initialState(initial));
  const baseline = useRef<FormState>(initialState(initial));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((previous) => ({ ...previous, [key]: value }));
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(state) as (keyof FormState)[]) {
      if (state[key] === baseline.current[key]) continue;
      if (key === "next_action_at") {
        patch[key] = state[key] ? new Date(state[key]).toISOString() : null;
      } else {
        patch[key] = state[key].trim() || null;
      }
    }
    if (Object.keys(patch).length === 0) {
      setMessage("No changes to save.");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/manifest/${encodeURIComponent(tenantSlug)}/records/lead?id=${encodeURIComponent(leadId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch }),
        },
      );
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!response.ok || !json.ok) {
        throw new Error(json.message || json.error || `save_${response.status}`);
      }
      baseline.current = state;
      setMessage("Lead context saved.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const websiteHref = safeExternalUrl(state.website);
  const disabled = saving || refreshPending;

  return (
    <section className="overflow-hidden rounded-2xl border border-bg-border bg-bg-deep/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-bg-border bg-bg-elev/35 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Lead context</h2>
          <p className="mt-1 text-xs text-fg-muted">
            The practical facts a rep or founder needs before the next conversation.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={save}
          className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-xs"
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {saving ? "Saving…" : "Save context"}
        </button>
      </div>

      <div className="space-y-6 p-5">
        <FieldGroup title="Contact">
          <TextField label="Contact name" value={state.name} onChange={(value) => set("name", value)} />
          <TextField label="Company" value={state.company} onChange={(value) => set("company", value)} />
          <TextField label="Email" type="email" value={state.email} onChange={(value) => set("email", value)} />
          <TextField label="Phone" type="tel" value={state.phone} onChange={(value) => set("phone", value)} />
        </FieldGroup>

        <FieldGroup title="Business and website">
          <label className="text-xs text-fg-muted md:col-span-2">
            Website
            <div className="mt-1.5 flex gap-2">
              <input
                value={state.website}
                onChange={(event) => set("website", event.target.value)}
                placeholder="https://example.com"
                className={INPUT}
              />
              {websiteHref && (
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open website"
                  className="btn-secondary inline-flex shrink-0 items-center !px-3"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </a>
              )}
            </div>
          </label>
          <TextField label="Industry" value={state.industry} onChange={(value) => set("industry", value)} />
          <div className="grid grid-cols-2 gap-2">
            <TextField label="City" value={state.business_city} onChange={(value) => set("business_city", value)} />
            <TextField label="Province / state" value={state.state} onChange={(value) => set("state", value)} />
          </div>
          <label className="text-xs text-fg-muted md:col-span-2">
            Website condition
            <input
              value={state.website_condition}
              onChange={(event) => set("website_condition", event.target.value)}
              placeholder="No site, dated site, slow mobile experience…"
              maxLength={240}
              className={`${INPUT} mt-1.5`}
            />
          </label>
          <label className="text-xs text-fg-muted md:col-span-2">
            Audit findings
            <textarea
              value={state.audit_findings}
              onChange={(event) => set("audit_findings", event.target.value)}
              placeholder="Specific problems and opportunities to use in the conversation"
              rows={4}
              maxLength={2000}
              className={`${INPUT} mt-1.5`}
            />
          </label>
        </FieldGroup>

        <FieldGroup title="Ongoing deal context">
          <label className="text-xs text-fg-muted md:col-span-2">
            Current notes
            <textarea
              value={state.notes}
              onChange={(event) => set("notes", event.target.value)}
              placeholder="Durable summary: needs, objections, stakeholders, and commitments"
              rows={5}
              maxLength={4000}
              className={`${INPUT} mt-1.5`}
            />
            <span className="mt-1 block text-[10px] text-fg-dim">
              Use the activity note below for a chronological touch; this field is the current summary.
            </span>
          </label>
          <label className="text-xs text-fg-muted">
            Next scheduled touch
            <input
              type="datetime-local"
              value={state.next_action_at}
              onChange={(event) => set("next_action_at", event.target.value)}
              className={`${INPUT} mt-1.5`}
            />
          </label>
        </FieldGroup>

        {message && (
          <div role="status" className="rounded-lg border border-bg-border bg-bg-elev/35 px-3 py-2 text-xs text-fg-muted">
            {message}
          </div>
        )}
      </div>
    </section>
  );
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-fg-dim">
        {title}
      </legend>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel";
}) {
  return (
    <label className="text-xs text-fg-muted">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${INPUT} mt-1.5`}
      />
    </label>
  );
}

function initialState(data: Record<string, unknown>): FormState {
  return {
    name: stringValue(data.name),
    company: stringValue(data.company),
    email: stringValue(data.email),
    phone: stringValue(data.phone),
    website: stringValue(data.website),
    industry: stringValue(data.industry),
    business_city: stringValue(data.business_city),
    state: stringValue(data.state),
    website_condition: stringValue(data.website_condition),
    audit_findings: stringValue(data.audit_findings),
    notes: stringValue(data.notes),
    next_action_at: localDateTime(stringValue(data.next_action_at)),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function localDateTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
