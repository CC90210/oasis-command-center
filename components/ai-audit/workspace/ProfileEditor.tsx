"use client";

/**
 * The discovery profile: every fact from the call, with its label and where it
 * came from. In phase 1 CC types them; from phase 2 the transcript fills them
 * and this is where CC reviews and corrects them before authorizing the audit.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PROFILE_FIELDS,
  PROFILE_GROUPS,
  PROFILE_GROUP_LABELS,
  missingEstimateFigures,
  type ProfileFieldDef,
} from "@/lib/ai-audit/profile";
import { EVIDENCE_LABEL_NAMES } from "@/lib/ai-audit/rules";
import type { ProfileField } from "@/lib/ai-audit/versions";
import { describeError, postAction } from "./api";

const SOURCE_WORDS: Record<string, string> = {
  call_notes: "Call notes",
  transcript: "Transcript",
  form: "Intake form",
  owner: "Entered by CC",
  research: "Research",
};

function show(def: ProfileFieldDef, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (def.type === "boolean") return value ? "Yes" : "No";
  if (def.type === "money") return `$${Number(value).toLocaleString("en-CA")}`;
  if (def.type === "number") return `${Number(value).toLocaleString("en-CA")}${def.unit ? ` ${def.unit}` : ""}`;
  if (def.type === "list" && Array.isArray(value)) return value.join("; ");
  if (def.type === "rows" && Array.isArray(value)) {
    return (value as Array<Record<string, string>>).map((r) => (def.columns ?? []).map((c) => r[c]).filter(Boolean).join(", ")).join("; ");
  }
  return String(value);
}

function toInput(def: ProfileFieldDef, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (def.type === "list" && Array.isArray(value)) return value.join("\n");
  if (def.type === "rows" && Array.isArray(value)) {
    return (value as Array<Record<string, string>>).map((r) => (def.columns ?? []).map((c) => r[c] ?? "").join(" | ")).join("\n");
  }
  if (def.type === "boolean") return value ? "yes" : "no";
  return String(value);
}

type Draft = { key: string; value: string; label: string; source: string; sourceNote: string; verifiedNote: string };

export function ProfileEditor({ engagementId, fields, frozen }: { engagementId: string; fields: ProfileField[]; frozen: boolean }) {
  const router = useRouter();
  const byKey = useMemo(() => new Map(fields.map((f) => [f.field_key, f])), [fields]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = missingEstimateFigures(new Set(fields.map((f) => f.field_key)));

  function open(def: ProfileFieldDef) {
    const f = byKey.get(def.key);
    setError(null);
    setDraft({
      key: def.key,
      value: toInput(def, f?.value),
      label: f?.label ?? "client_reported",
      source: f?.source_type ?? "call_notes",
      sourceNote: typeof f?.source_ref?.note === "string" ? (f.source_ref.note as string) : "",
      verifiedNote: f?.verified_note ?? "",
    });
  }

  async function save() {
    if (!draft) return;
    const def = PROFILE_FIELDS.find((d) => d.key === draft.key);
    if (!def) return;
    // An empty answer is never saved as a value: an empty number would become 0
    // (an invented figure) and an untouched yes/no would become No.
    if ((def.type === "boolean" || def.type === "number" || def.type === "money") && !draft.value.trim()) {
      setError(def.type === "boolean" ? "Choose Yes or No first." : "Enter the figure first, or cancel to leave it as a gap.");
      return;
    }
    let value: unknown = draft.value;
    if (def.type === "number" || def.type === "money") value = Number(draft.value.replace(/[$,\s]/g, ""));
    if (def.type === "boolean") value = draft.value.trim().toLowerCase().startsWith("y");
    setBusy(true);
    const r = await postAction(engagementId, "save_profile_field", {
      field: { field_key: draft.key, value, label: draft.label, source_type: draft.source, source_note: draft.sourceNote, verified_note: draft.verifiedNote },
    });
    setBusy(false);
    if (!r.ok) {
      setError(describeError(r));
      return;
    }
    setDraft(null);
    router.refresh();
  }

  async function remove(key: string) {
    setBusy(true);
    const r = await postAction(engagementId, "delete_profile_field", { field_key: key });
    setBusy(false);
    if (!r.ok) setError(describeError(r));
    else router.refresh();
  }

  return (
    <div className="space-y-5">
      {missing.length > 0 ? (
        <div className="rounded-lg border border-hairline bg-bg-raised px-4 py-3 text-sm">
          <div className="font-medium text-fg">Figures the estimates still need</div>
          <div className="mt-1 text-fg-muted">{missing.map((m) => m.label).join(", ")}.</div>
        </div>
      ) : null}
      {frozen ? <p className="text-sm text-fg-muted">This profile is authorized (Gate 1), so it cannot change. To correct it, move the engagement back to Transcript Awaiting Approval and authorize it again.</p> : null}
      {error ? <p className="text-sm text-status-hot">{error}</p> : null}
      {PROFILE_GROUPS.map((g) => (
        <section key={g} className="rounded-xl border border-hairline bg-bg-panel">
          <h3 className="border-b border-hairline px-4 py-2.5 text-sm font-semibold text-fg">{PROFILE_GROUP_LABELS[g]}</h3>
          <ul className="divide-y divide-hairline">
            {PROFILE_FIELDS.filter((d) => d.group === g).map((def) => {
              const f = byKey.get(def.key);
              const editing = draft?.key === def.key;
              return (
                <li key={def.key} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-fg-muted">
                        {def.label}
                        {def.needed_for_estimates ? <span className="ml-2 text-[11px] text-fg-dim">used in estimates</span> : null}
                      </div>
                      {f ? (
                        <div className="mt-0.5 text-sm text-fg">
                          {show(def, f.value)}
                          <span className="ml-2 text-[12px] text-fg-dim">
                            {EVIDENCE_LABEL_NAMES[f.label]}, {SOURCE_WORDS[f.source_type] ?? f.source_type}
                            {f.source_type === "transcript" && typeof f.source_ref.from === "number" ? `, lines ${f.source_ref.from}${f.source_ref.to !== f.source_ref.from ? `-${String(f.source_ref.to)}` : ""}` : ""}
                            {f.source_type === "transcript" && Array.isArray(f.source_ref.speakers) && f.source_ref.speakers.length ? `, said by ${(f.source_ref.speakers as unknown[]).map(String).join(" and ")}` : ""}
                            {f.owner_corrected ? ", corrected by CC" : ""}
                          </span>
                          {f.evidence_quote ? <div className="mt-0.5 text-[12px] italic text-fg-dim">&ldquo;{f.evidence_quote}&rdquo;</div> : null}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-sm text-fg-dim">Not captured</div>
                      )}
                    </div>
                    {!editing && !frozen ? (
                      <div className="flex gap-2">
                        <button type="button" className="btn-secondary" onClick={() => open(def)} disabled={busy}>
                          {f ? "Edit" : "Add"}
                        </button>
                        {f ? (
                          <button type="button" className="btn-danger" onClick={() => remove(def.key)} disabled={busy}>
                            Remove
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {editing && draft ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="md:col-span-2">
                        <label className="label" htmlFor={`v-${def.key}`}>
                          Value
                          {def.type === "list" ? " (one per line)" : def.type === "rows" ? ` (one per line: ${(def.columns ?? []).join(" | ")})` : def.unit ? ` (${def.unit})` : ""}
                        </label>
                        {def.type === "text" || def.type === "list" || def.type === "rows" ? (
                          <textarea id={`v-${def.key}`} className="textarea" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                        ) : def.type === "boolean" ? (
                          <select id={`v-${def.key}`} className="select" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })}>
                            <option value="" disabled>
                              Choose
                            </option>
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        ) : (
                          <input id={`v-${def.key}`} className="input" inputMode="decimal" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                        )}
                      </div>
                      <div>
                        <label className="label" htmlFor={`l-${def.key}`}>
                          Label
                        </label>
                        <select id={`l-${def.key}`} className="select" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}>
                          <option value="client_reported">Client-reported (they told us)</option>
                          <option value="verified">Verified fact (we have evidence)</option>
                          <option value="hypothesis">Hypothesis (needs checking)</option>
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor={`s-${def.key}`}>
                          Where it came from
                        </label>
                        <select id={`s-${def.key}`} className="select" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
                          {Object.entries(SOURCE_WORDS).map(([k, w]) => (
                            <option key={k} value={k}>
                              {w}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor={`n-${def.key}`}>
                          Source note (optional)
                        </label>
                        <input id={`n-${def.key}`} className="input" value={draft.sourceNote} onChange={(e) => setDraft({ ...draft, sourceNote: e.target.value })} placeholder="e.g. said around minute 12" />
                      </div>
                      {draft.label === "verified" ? (
                        <div>
                          <label className="label" htmlFor={`vn-${def.key}`}>
                            What confirmed it
                          </label>
                          <input id={`vn-${def.key}`} className="input" value={draft.verifiedNote} onChange={(e) => setDraft({ ...draft, verifiedNote: e.target.value })} placeholder="e.g. their Google Analytics report, shared on the call" />
                        </div>
                      ) : null}
                      <div className="flex gap-2 md:col-span-2">
                        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
                          Save
                        </button>
                        <button type="button" className="btn-secondary" onClick={() => setDraft(null)} disabled={busy}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
