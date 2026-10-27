"use client";

/**
 * The audit draft editor: all nine sections plus the findings, estimates and
 * sources they cite. The evidence rules (lib/ai-audit/doc.ts auditDocIssues)
 * run live as CC types, the same rules the server enforces on submission:
 * a figure needs a citation, a Verified fact needs a source, a Hypothesis
 * carries no figure and says how to test it, an estimate shows its inputs,
 * assumptions and a range. Prices are not here: they live in the proposal.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SECTION_TITLES,
  SOURCE_KINDS,
  auditDocIssues,
  emptyAuditDoc,
  type AuditDoc,
  type DocEstimate,
  type DocFinding,
  type DocOpportunity,
  type DocParagraph,
  type DocRoadmapItem,
  type DocSource,
} from "@/lib/ai-audit/doc";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, EVIDENCE_LABEL_NAMES, type BusinessType, type EvidenceLabel } from "@/lib/ai-audit/rules";
import { describeError, postAction } from "./api";
import { NumberInput } from "./inputs";

type Props = {
  engagementId: string;
  initialDoc: AuditDoc | null;
  rowVersion: number;
  editable: boolean;
  defaults: { businessName: string; businessType: BusinessType; contactName: string; website: string; location: string };
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function nextId(prefix: string, used: string[]): string {
  let n = 1;
  for (const id of used) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${prefix}${n}`;
}

function parseIds(s: string): string[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function lines(s: string): string[] {
  return s.split("\n").map((x) => x.trim()).filter(Boolean);
}

function commaList(s: string): string[] {
  return s.split(",").map((d) => d.trim()).filter(Boolean);
}

/**
 * A comma-separated list in one line. The raw text is kept while CC types, so
 * "f1, " keeps its comma and "Google " keeps its space; the parsed list goes up
 * on every keystroke. When the list changes from outside (a row above was
 * removed, the draft was reloaded) the field shows the new list, not stale text.
 */
function ListInput({ value, onChange, disabled, placeholder, parse = parseIds }: { value: string[]; onChange: (ids: string[]) => void; disabled: boolean; placeholder?: string; parse?: (s: string) => string[] }) {
  const [text, setText] = useState(value.join(", "));
  const parsed = parse(text);
  const shown = parsed.length === value.length && parsed.every((x, i) => x === value[i]) ? text : value.join(", ");
  return (
    <input
      className="input"
      disabled={disabled}
      value={shown}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

const LABEL_OPTIONS: EvidenceLabel[] = ["verified", "client_reported", "hypothesis"];

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[12px] text-fg-dim">{hint}</div> : null}
    </div>
  );
}

function Box({ title, children, onRemove }: { title: string; children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="rounded-lg border border-hairline bg-bg-raised p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        {onRemove ? (
          <button type="button" className="btn-danger" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Paragraphs({ value, onChange, disabled }: { value: DocParagraph[]; onChange: (v: DocParagraph[]) => void; disabled: boolean }) {
  return (
    <div className="grid gap-3">
      {value.map((p, i) => (
        <Box key={i} title={`Paragraph ${i + 1}`} onRemove={disabled ? undefined : () => onChange(value.filter((_, j) => j !== i))}>
          <textarea className="textarea" disabled={disabled} value={p.text} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
          <Field label="Cites (finding, estimate or source ids)" hint="Required whenever the paragraph states a figure. Example: f1, s2">
            <ListInput disabled={disabled} value={p.cites} onChange={(ids) => onChange(value.map((x, j) => (j === i ? { ...x, cites: ids } : x)))} />
          </Field>
        </Box>
      ))}
      {!disabled ? (
        <button type="button" className="btn-secondary justify-self-start" onClick={() => onChange([...value, { text: "", cites: [] }])}>
          Add paragraph
        </button>
      ) : null}
    </div>
  );
}

function OptionalParagraph({ value, onChange, disabled, label }: { value: DocParagraph | undefined; onChange: (v: DocParagraph | undefined) => void; disabled: boolean; label: string }) {
  return (
    <Box title={label}>
      <textarea className="textarea" disabled={disabled} value={value?.text ?? ""} onChange={(e) => onChange(e.target.value ? { text: e.target.value, cites: value?.cites ?? [] } : undefined)} />
      <Field label="Cites">
        <ListInput disabled={disabled} value={value?.cites ?? []} onChange={(ids) => onChange({ text: value?.text ?? "", cites: ids })} />
      </Field>
    </Box>
  );
}

function Lines({ value, onChange, disabled, label, hint }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean; label: string; hint?: string }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <Field label={label} hint={hint ?? "One per line."}>
      <textarea
        className="textarea"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(lines(e.target.value));
        }}
      />
    </Field>
  );
}

function RoadmapBucket({ title, items, opportunities, onChange, disabled }: { title: string; items: DocRoadmapItem[]; opportunities: DocOpportunity[]; onChange: (v: DocRoadmapItem[]) => void; disabled: boolean }) {
  return (
    <div className="grid gap-2">
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {items.map((r, i) => (
        <Box key={i} title={opportunities.find((o) => o.id === r.opportunity_id)?.title ?? r.opportunity_id} onRemove={disabled ? undefined : () => onChange(items.filter((_, j) => j !== i))}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Opportunity">
              <select className="select" disabled={disabled} value={r.opportunity_id} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, opportunity_id: e.target.value } : x)))}>
                {opportunities.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title || o.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Impact">
              <select className="select" disabled={disabled} value={r.impact} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, impact: e.target.value as DocRoadmapItem["impact"] } : x)))}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </Field>
            <Field label="Effort">
              <select className="select" disabled={disabled} value={r.effort} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, effort: e.target.value as DocRoadmapItem["effort"] } : x)))}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
          <Field label="Urgency (optional)">
            <input className="input" disabled={disabled} value={r.urgency} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, urgency: e.target.value } : x)))} />
          </Field>
          <Field label="Depends on (comma separated)">
            <ListInput disabled={disabled} value={r.dependencies} parse={commaList} onChange={(ids) => onChange(items.map((x, j) => (j === i ? { ...x, dependencies: ids } : x)))} />
          </Field>
        </Box>
      ))}
      {!disabled && opportunities.length ? (
        <button type="button" className="btn-secondary justify-self-start" onClick={() => onChange([...items, { opportunity_id: opportunities[0].id, impact: "medium", effort: "medium", dependencies: [], urgency: "" }])}>
          Add to {title}
        </button>
      ) : null}
    </div>
  );
}

export function AuditEditor({ engagementId, initialDoc, rowVersion, editable, defaults }: Props) {
  const router = useRouter();
  const [doc, setDoc] = useState<AuditDoc>(
    () =>
      initialDoc ??
      emptyAuditDoc({
        businessName: defaults.businessName || "the business",
        businessType: defaults.businessType,
        contactName: defaults.contactName,
        website: defaults.website || undefined,
        location: defaults.location || undefined,
        today: new Date().toISOString(),
      }),
  );
  const [rv, setRv] = useState(rowVersion);
  // The editor stays mounted while CC works in other tabs; their saves move the
  // engagement's row version, and this editor follows (its own draft is kept).
  useEffect(() => setRv(rowVersion), [rowVersion]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const issues = useMemo(() => auditDocIssues(doc), [doc]);
  const blocking = issues.filter((i) => i.severity === "block");
  const disabled = !editable || busy;

  function update(fn: (d: AuditDoc) => void) {
    setDoc((prev) => {
      const next = clone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    const r = await postAction(engagementId, "save_audit", { doc, expected_row_version: rv });
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    if (typeof r.row_version === "number") setRv(r.row_version);
    setDirty(false);
    setMessage("Saved.");
    router.refresh();
  }

  const allIds = [...doc.findings.map((f) => f.id), ...doc.estimates.map((e) => e.id), ...doc.sources.map((s) => s.id), ...doc.sections.opportunities.items.map((o) => o.id)];

  return (
    <div className="grid gap-5">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-bg-panel px-4 py-2.5">
        <div className="text-sm text-fg-muted">
          {blocking.length ? `${blocking.length} item${blocking.length === 1 ? "" : "s"} to fix before submitting` : "Meets every evidence rule"}
          {dirty ? <span className="ml-2 text-status-warm">Unsaved changes</span> : null}
          {message ? <span className="ml-2 text-fg">{message}</span> : null}
        </div>
        <div className="flex gap-2">
          <a className="btn-secondary" href={`/ai-audits/${engagementId}/preview`} target="_blank" rel="noreferrer">
            Preview
          </a>
          {editable ? (
            <button type="button" className="btn-primary" onClick={save} disabled={busy || !dirty}>
              Save draft
            </button>
          ) : null}
        </div>
      </div>

      {!editable ? <p className="text-sm text-fg-muted">This version is submitted or delivered, so it is read-only. Reopen it to make changes.</p> : null}

      {issues.length ? (
        <details className="rounded-lg border border-hairline bg-bg-panel px-4 py-3" open={blocking.length > 0}>
          <summary className="cursor-pointer text-sm font-medium text-fg">Evidence check ({issues.length})</summary>
          <ul className="mt-2 grid gap-1 text-[13px]">
            {issues.map((i, k) => (
              <li key={k} className={i.severity === "block" ? "text-status-hot" : "text-fg-muted"}>
                {i.path}: {i.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Cover</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Business name">
            <input className="input" disabled={disabled} value={doc.business.name} onChange={(e) => update((d) => void (d.business.name = e.target.value))} />
          </Field>
          <Field label="Business type">
            <select className="select" disabled={disabled} value={doc.business.type} onChange={(e) => update((d) => void (d.business.type = e.target.value as BusinessType))}>
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BUSINESS_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prepared for">
            <input className="input" disabled={disabled} value={doc.prepared_for.name} onChange={(e) => update((d) => void (d.prepared_for.name = e.target.value))} />
          </Field>
          <Field label="Date">
            <input className="input" type="date" disabled={disabled} value={doc.prepared_on} onChange={(e) => update((d) => void (d.prepared_on = e.target.value))} />
          </Field>
          <Field label="Location (optional)">
            <input className="input" disabled={disabled} value={doc.business.location ?? ""} onChange={(e) => update((d) => void (d.business.location = e.target.value || undefined))} />
          </Field>
          <Field label="Website (optional)">
            <input className="input" disabled={disabled} value={doc.business.website ?? ""} onChange={(e) => update((d) => void (d.business.website = e.target.value || undefined))} />
          </Field>
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Sources</h3>
        <p className="text-[13px] text-fg-muted">Everything a Verified fact or a figure points to. A conversation with the client is a source of kind &quot;client&quot;.</p>
        {doc.sources.map((s, i) => (
          <Box key={s.id} title={`${s.id}: ${s.title || "untitled"}`} onRemove={disabled ? undefined : () => update((d) => void d.sources.splice(i, 1))}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Title">
                <input className="input" disabled={disabled} value={s.title} onChange={(e) => update((d) => void (d.sources[i].title = e.target.value))} />
              </Field>
              <Field label="Kind">
                <select className="select" disabled={disabled} value={s.kind} onChange={(e) => update((d) => void (d.sources[i].kind = e.target.value as DocSource["kind"]))}>
                  {SOURCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Publisher (optional)">
                <input className="input" disabled={disabled} value={s.publisher ?? ""} onChange={(e) => update((d) => void (d.sources[i].publisher = e.target.value || undefined))} />
              </Field>
              <Field label="Web address (required for web sources)">
                <input className="input" disabled={disabled} value={s.url ?? ""} onChange={(e) => update((d) => void (d.sources[i].url = e.target.value || undefined))} />
              </Field>
              <Field label="Checked on">
                <input className="input" type="date" disabled={disabled} value={s.retrieved_at?.slice(0, 10) ?? ""} onChange={(e) => update((d) => void (d.sources[i].retrieved_at = e.target.value || undefined))} />
              </Field>
              <Field label="Note (optional)">
                <input className="input" disabled={disabled} value={s.note ?? ""} onChange={(e) => update((d) => void (d.sources[i].note = e.target.value || undefined))} />
              </Field>
            </div>
          </Box>
        ))}
        {!disabled ? (
          <button type="button" className="btn-secondary justify-self-start" onClick={() => update((d) => void d.sources.push({ id: nextId("s", allIds), kind: "client", title: "Discovery call" }))}>
            Add source
          </button>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Findings</h3>
        {doc.findings.map((f, i) => (
          <Box key={f.id} title={`${f.id}: ${f.title || "untitled"}`} onRemove={disabled ? undefined : () => update((d) => void d.findings.splice(i, 1))}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Title">
                <input className="input" disabled={disabled} value={f.title} onChange={(e) => update((d) => void (d.findings[i].title = e.target.value))} />
              </Field>
              <Field label="Label">
                <select className="select" disabled={disabled} value={f.label} onChange={(e) => update((d) => void (d.findings[i].label = e.target.value as EvidenceLabel))}>
                  {LABEL_OPTIONS.map((l) => (
                    <option key={l} value={l}>
                      {EVIDENCE_LABEL_NAMES[l]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Statement">
              <textarea className="textarea" disabled={disabled} value={f.statement} onChange={(e) => update((d) => void (d.findings[i].statement = e.target.value))} />
            </Field>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Figure (optional)">
                <NumberInput
                  disabled={disabled}
                  value={f.metric ? f.metric.value : null}
                  onChange={(n) =>
                    update((d) => {
                      if (n === null) delete d.findings[i].metric;
                      else d.findings[i].metric = { value: n, unit: d.findings[i].metric?.unit ?? "" };
                    })
                  }
                />
              </Field>
              <Field label="Unit">
                <input className="input" disabled={disabled || !f.metric} value={f.metric?.unit ?? ""} onChange={(e) => update((d) => void (d.findings[i].metric && (d.findings[i].metric!.unit = e.target.value)))} />
              </Field>
              <Field label="Sources (ids)">
                <ListInput disabled={disabled} value={f.source_ids} onChange={(ids) => update((d) => void (d.findings[i].source_ids = ids))} />
              </Field>
            </div>
            {f.label === "hypothesis" ? (
              <Field label="How it could be tested">
                <input className="input" disabled={disabled} value={f.how_to_test ?? ""} onChange={(e) => update((d) => void (d.findings[i].how_to_test = e.target.value || undefined))} />
              </Field>
            ) : null}
          </Box>
        ))}
        {!disabled ? (
          <button
            type="button"
            className="btn-secondary justify-self-start"
            onClick={() =>
              update((d) => {
                const id = nextId("f", allIds);
                d.findings.push({ id, title: "", statement: "", label: "client_reported", source_ids: [] } as DocFinding);
                d.sections.key_findings.finding_ids.push(id);
              })
            }
          >
            Add finding
          </button>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Estimates</h3>
        <p className="text-[13px] text-fg-muted">A range, its inputs with their labels, and the assumptions behind it. Never a promise.</p>
        {doc.estimates.map((e, i) => (
          <Box key={e.id} title={`${e.id}: ${e.title || "untitled"}`} onRemove={disabled ? undefined : () => update((d) => void d.estimates.splice(i, 1))}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Title">
                <input className="input" disabled={disabled} value={e.title} onChange={(ev) => update((d) => void (d.estimates[i].title = ev.target.value))} />
              </Field>
              <Field label="How it is worked out">
                <input className="input" disabled={disabled} value={e.formula} onChange={(ev) => update((d) => void (d.estimates[i].formula = ev.target.value))} placeholder="hours per week x 52 x share automated" />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Low">
                <NumberInput disabled={disabled} value={e.low} emptyValue={0} onChange={(n) => update((d) => void (d.estimates[i].low = n ?? 0))} />
              </Field>
              <Field label="High">
                <NumberInput disabled={disabled} value={e.high} emptyValue={0} onChange={(n) => update((d) => void (d.estimates[i].high = n ?? 0))} />
              </Field>
              <Field label="Unit">
                <input className="input" disabled={disabled} value={e.unit} onChange={(ev) => update((d) => void (d.estimates[i].unit = ev.target.value))} />
              </Field>
              <Field label="Period (optional)">
                <input className="input" disabled={disabled} value={e.period ?? ""} onChange={(ev) => update((d) => void (d.estimates[i].period = ev.target.value || undefined))} placeholder="a year" />
              </Field>
            </div>
            <div className="grid gap-2">
              <div className="label">Inputs</div>
              {e.inputs.map((inp, k) => (
                <div key={k} className="grid gap-2 md:grid-cols-5">
                  <input className="input md:col-span-2" disabled={disabled} value={inp.name} placeholder="name" onChange={(ev) => update((d) => void (d.estimates[i].inputs[k].name = ev.target.value))} />
                  <NumberInput disabled={disabled} value={inp.value} emptyValue={0} placeholder="value" onChange={(n) => update((d) => void (d.estimates[i].inputs[k].value = n ?? 0))} />
                  <select className="select" disabled={disabled} value={inp.label} onChange={(ev) => update((d) => void (d.estimates[i].inputs[k].label = ev.target.value as EvidenceLabel))}>
                    {(["client_reported", "verified", "hypothesis"] as EvidenceLabel[]).map((l) => (
                      <option key={l} value={l}>
                        {EVIDENCE_LABEL_NAMES[l]}
                      </option>
                    ))}
                  </select>
                  <input className="input" disabled={disabled} value={inp.basis ?? ""} placeholder="basis (source id or note)" onChange={(ev) => update((d) => void (d.estimates[i].inputs[k].basis = ev.target.value || undefined))} />
                </div>
              ))}
              {!disabled ? (
                <button type="button" className="btn-secondary justify-self-start" onClick={() => update((d) => void d.estimates[i].inputs.push({ name: "", value: 0, label: "client_reported" }))}>
                  Add input
                </button>
              ) : null}
            </div>
            <Lines label="Assumptions" disabled={disabled} value={e.assumptions} onChange={(v) => update((d) => void (d.estimates[i].assumptions = v))} />
          </Box>
        ))}
        {!disabled ? (
          <button
            type="button"
            className="btn-secondary justify-self-start"
            onClick={() =>
              update((d) => {
                const id = nextId("e", allIds);
                d.estimates.push({ id, title: "", formula: "", low: 0, high: 0, unit: "hours", period: "a year", inputs: [], assumptions: [] } as DocEstimate);
                d.sections.impact.estimate_ids.push(id);
              })
            }
          >
            Add estimate
          </button>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">01 {SECTION_TITLES[0]}</h3>
        <Paragraphs disabled={disabled} value={doc.sections.executive_overview.paragraphs} onChange={(v) => update((d) => void (d.sections.executive_overview.paragraphs = v))} />
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">02 {SECTION_TITLES[1]}</h3>
        <Paragraphs disabled={disabled} value={doc.sections.current_assessment.paragraphs} onChange={(v) => update((d) => void (d.sections.current_assessment.paragraphs = v))} />
        <div className="label">Systems and tools in use</div>
        {doc.sections.current_assessment.systems.map((s, i) => (
          <Box key={i} title={s.name || `System ${i + 1}`} onRemove={disabled ? undefined : () => update((d) => void d.sections.current_assessment.systems.splice(i, 1))}>
            <div className="grid gap-3 md:grid-cols-3">
              <input className="input" disabled={disabled} value={s.name} placeholder="name" onChange={(e) => update((d) => void (d.sections.current_assessment.systems[i].name = e.target.value))} />
              <input className="input" disabled={disabled} value={s.role} placeholder="what it does today" onChange={(e) => update((d) => void (d.sections.current_assessment.systems[i].role = e.target.value))} />
              <select className="select" disabled={disabled} value={s.label} onChange={(e) => update((d) => void (d.sections.current_assessment.systems[i].label = e.target.value as EvidenceLabel))}>
                {LABEL_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {EVIDENCE_LABEL_NAMES[l]}
                  </option>
                ))}
              </select>
            </div>
            <ListInput disabled={disabled} value={s.cites} placeholder="cites" onChange={(ids) => update((d) => void (d.sections.current_assessment.systems[i].cites = ids))} />
          </Box>
        ))}
        {!disabled ? (
          <button type="button" className="btn-secondary justify-self-start" onClick={() => update((d) => void d.sections.current_assessment.systems.push({ name: "", role: "", label: "client_reported", cites: [] }))}>
            Add system
          </button>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">03 {SECTION_TITLES[2]}</h3>
        <OptionalParagraph label="Introduction (optional)" disabled={disabled} value={doc.sections.key_findings.intro} onChange={(v) => update((d) => void (d.sections.key_findings.intro = v))} />
        <Field label="Findings shown, in order (ids)" hint="New findings are added here automatically.">
          <ListInput disabled={disabled} value={doc.sections.key_findings.finding_ids} onChange={(ids) => update((d) => void (d.sections.key_findings.finding_ids = ids))} />
        </Field>
        <div className="label">What we could not verify</div>
        {doc.gaps.map((g, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-3">
            <input className="input" disabled={disabled} value={g.topic} placeholder="topic" onChange={(e) => update((d) => void (d.gaps[i].topic = e.target.value))} />
            <input className="input md:col-span-2" disabled={disabled} value={g.why} placeholder="why it is unknown" onChange={(e) => update((d) => void (d.gaps[i].why = e.target.value))} />
          </div>
        ))}
        {!disabled ? (
          <button type="button" className="btn-secondary justify-self-start" onClick={() => update((d) => void d.gaps.push({ topic: "", why: "" }))}>
            Add gap
          </button>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">04 {SECTION_TITLES[3]}</h3>
        {doc.sections.inefficiencies.items.map((it, i) => (
          <Box key={i} title={it.title || `Item ${i + 1}`} onRemove={disabled ? undefined : () => update((d) => void d.sections.inefficiencies.items.splice(i, 1))}>
            <Field label="Title">
              <input className="input" disabled={disabled} value={it.title} onChange={(e) => update((d) => void (d.sections.inefficiencies.items[i].title = e.target.value))} />
            </Field>
            <Field label="Why it matters">
              <textarea className="textarea" disabled={disabled} value={it.why_it_matters.text} onChange={(e) => update((d) => void (d.sections.inefficiencies.items[i].why_it_matters.text = e.target.value))} />
            </Field>
            <Field label="Cites for why it matters">
              <ListInput disabled={disabled} value={it.why_it_matters.cites} onChange={(ids) => update((d) => void (d.sections.inefficiencies.items[i].why_it_matters.cites = ids))} />
            </Field>
            <Field label="If nothing changes">
              <textarea className="textarea" disabled={disabled} value={it.consequence.text} onChange={(e) => update((d) => void (d.sections.inefficiencies.items[i].consequence.text = e.target.value))} />
            </Field>
            <Field label="Cites for the consequence">
              <ListInput disabled={disabled} value={it.consequence.cites} onChange={(ids) => update((d) => void (d.sections.inefficiencies.items[i].consequence.cites = ids))} />
            </Field>
            <Field label="Related findings (ids)">
              <ListInput disabled={disabled} value={it.finding_ids} onChange={(ids) => update((d) => void (d.sections.inefficiencies.items[i].finding_ids = ids))} />
            </Field>
          </Box>
        ))}
        {!disabled ? (
          <button type="button" className="btn-secondary justify-self-start" onClick={() => update((d) => void d.sections.inefficiencies.items.push({ title: "", why_it_matters: { text: "", cites: [] }, consequence: { text: "", cites: [] }, finding_ids: [] }))}>
            Add inefficiency
          </button>
        ) : null}
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">05 {SECTION_TITLES[4]}</h3>
        {doc.sections.opportunities.items.map((o, i) => (
          <Box key={o.id} title={`${o.id}: ${o.title || "untitled"}`} onRemove={disabled ? undefined : () => update((d) => void d.sections.opportunities.items.splice(i, 1))}>
            <Field label="Title">
              <input className="input" disabled={disabled} value={o.title} onChange={(e) => update((d) => void (d.sections.opportunities.items[i].title = e.target.value))} />
            </Field>
            {(
              [
                ["what_it_does", "What it does"],
                ["problem", "The problem it solves"],
                ["how_it_works", "How it would work in their operations"],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label}>
                <textarea className="textarea" disabled={disabled} value={o[k]} onChange={(e) => update((d) => void (d.sections.opportunities.items[i][k] = e.target.value))} />
              </Field>
            ))}
            <Field label="Systems involved (comma separated)">
              <ListInput disabled={disabled} value={o.integrations} parse={commaList} onChange={(ids) => update((d) => void (d.sections.opportunities.items[i].integrations = ids))} />
            </Field>
            <Field label="What could improve (cite the estimate)">
              <textarea className="textarea" disabled={disabled} value={o.expected_improvement.text} onChange={(e) => update((d) => void (d.sections.opportunities.items[i].expected_improvement.text = e.target.value))} />
            </Field>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Cites">
                <ListInput disabled={disabled} value={o.expected_improvement.cites} onChange={(ids) => update((d) => void (d.sections.opportunities.items[i].expected_improvement.cites = ids))} />
              </Field>
              <Field label="Findings it answers">
                <ListInput disabled={disabled} value={o.finding_ids} onChange={(ids) => update((d) => void (d.sections.opportunities.items[i].finding_ids = ids))} />
              </Field>
              <Field label="Estimates">
                <ListInput disabled={disabled} value={o.estimate_ids} onChange={(ids) => update((d) => void (d.sections.opportunities.items[i].estimate_ids = ids))} />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Lines label="Workflow today (steps)" disabled={disabled} value={o.workflow?.before ?? []} onChange={(v) => update((d) => void (d.sections.opportunities.items[i].workflow = { before: v, after: d.sections.opportunities.items[i].workflow?.after ?? [] }))} />
              <Lines label="Workflow with the change (steps)" disabled={disabled} value={o.workflow?.after ?? []} onChange={(v) => update((d) => void (d.sections.opportunities.items[i].workflow = { before: d.sections.opportunities.items[i].workflow?.before ?? [], after: v }))} />
            </div>
          </Box>
        ))}
        {!disabled ? (
          <button
            type="button"
            className="btn-secondary justify-self-start"
            onClick={() => update((d) => void d.sections.opportunities.items.push({ id: nextId("o", allIds), title: "", what_it_does: "", problem: "", how_it_works: "", integrations: [], expected_improvement: { text: "", cites: [] }, finding_ids: [], estimate_ids: [] }))}
          >
            Add opportunity
          </button>
        ) : null}
      </section>

      <section className="grid gap-4 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">06 {SECTION_TITLES[5]}</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <RoadmapBucket title="Now" disabled={disabled} items={doc.sections.roadmap.now} opportunities={doc.sections.opportunities.items} onChange={(v) => update((d) => void (d.sections.roadmap.now = v))} />
          <RoadmapBucket title="Next" disabled={disabled} items={doc.sections.roadmap.next} opportunities={doc.sections.opportunities.items} onChange={(v) => update((d) => void (d.sections.roadmap.next = v))} />
          <RoadmapBucket title="Later" disabled={disabled} items={doc.sections.roadmap.later} opportunities={doc.sections.opportunities.items} onChange={(v) => update((d) => void (d.sections.roadmap.later = v))} />
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">07 {SECTION_TITLES[6]}</h3>
        <OptionalParagraph label="Introduction (optional)" disabled={disabled} value={doc.sections.impact.intro} onChange={(v) => update((d) => void (d.sections.impact.intro = v))} />
        <Field label="Estimates shown, in order (ids)" hint="New estimates are added here automatically.">
          <ListInput disabled={disabled} value={doc.sections.impact.estimate_ids} onChange={(ids) => update((d) => void (d.sections.impact.estimate_ids = ids))} />
        </Field>
        <Lines label="Limits of these estimates" disabled={disabled} value={doc.sections.impact.limitations} onChange={(v) => update((d) => void (d.sections.impact.limitations = v))} />
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">08 {SECTION_TITLES[7]}</h3>
        <p className="text-[13px] text-fg-muted">Drawn from the proposal (Proposal tab), so prices only ever come from the confirmed catalogue or a price you set.</p>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">09 {SECTION_TITLES[8]}</h3>
        <Lines label="What happens next (steps)" disabled={disabled} value={doc.sections.next_steps.steps} onChange={(v) => update((d) => void (d.sections.next_steps.steps = v))} />
      </section>
    </div>
  );
}
