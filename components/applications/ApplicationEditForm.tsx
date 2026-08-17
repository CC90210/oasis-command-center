"use client";

/**
 * ApplicationEditForm — inline "Edit application" editor for the merchant
 * APPLICATION profile (LeadFileBody, entity === "application").
 *
 * Sectioned form (Business / Contact / Owner / Partner / Funding) pre-populated
 * from the application record's data. Dirty-tracked: "Complete & Save" builds
 * the PATCH from CHANGED keys only (empty string → null to clear a value),
 * normalizes each value to the canonical shapes the rest of the system expects
 * (lib/forms/application-upsert.ts `normalize`: uppercase 2-letter state,
 * lowercase industry, parsed currency numbers, digit phones per the repo's
 * normPhone convention, YYYY-MM-DD dates), then makes ONE call:
 *
 *   PATCH /api/applications/[id]/edit  { patch }
 *
 * That route (rep-capable, canWriteCrm — NOT the admin-only manifest records
 * PATCH) atomically merges the patch into the record's data jsonb AND
 * regenerates the filed application PDF server-side (replace-and-refile:
 * soft-deletes the prior generated final_application_form, files a fresh
 * copy). Response: { ok, record, pdf: { regenerated, document_id?, error? } }.
 * The editable surface is exactly APPLICATION_FIELD_KEYS — any other key is
 * rejected with invalid_key, so the patch must never carry stray keys.
 *
 * On success, onSaved(record.data) fires regardless of the pdf outcome (the
 * data IS saved either way); a pdf.regenerated=false comes back as a
 * non-blocking warning with the Docs-tab retry hint. On failure the exact
 * error is surfaced inline and the form stays open with the edits intact.
 *
 * Alias mirroring: a changed business_legal_name also writes business_name,
 * and a changed owner_full_name also writes owner_name — both are canonical
 * whitelist keys (application-upsert FIELD_ALIASES writes them the same way on
 * every form submission) and they're what resolveTitle / the drawer header
 * read. Legacy lead-side display keys (legal_name, state, ein, ownership_pct,
 * owner_ssn_last4…) are NOT whitelisted by the route and are left alone.
 *
 * PII discipline: owner/partner SSN + DOB are edited as plain inputs
 * (operators legitimately correct them) but are NEVER logged — no console
 * statements in this file, autoComplete off on sensitive fields.
 */

import { useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2 } from "lucide-react";
// Pure module, no server-only import — unlike application-upsert.ts, which is
// why the state map below is duplicated rather than shared.
import { isAcceptableCaptureAddress } from "@/lib/address/us-address";

type Phase = "idle" | "saving" | "success";

type FieldKind =
  | "text"
  | "email"
  | "phone"
  | "money"
  | "pct"
  | "int"
  | "date"
  | "ssn"
  | "state"
  | "industry"
  | "address";

type FieldDef = {
  /** Canonical application data key (lib/forms/application-upsert.ts whitelist). */
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  /** Span both columns of the section grid. */
  wide?: boolean;
  /** SSN-class field: autoComplete off. Values are never logged anywhere. */
  sensitive?: boolean;
};

const SECTIONS: { title: string; hint?: string; fields: FieldDef[] }[] = [
  {
    title: "Business",
    fields: [
      { key: "business_legal_name", label: "Legal business name", kind: "text", wide: true },
      { key: "dba", label: "DBA", kind: "text" },
      { key: "entity_type", label: "Entity type", kind: "text", placeholder: "LLC, Corp, Sole Prop…" },
      { key: "business_address", label: "Business address", kind: "address", wide: true },
      { key: "business_state", label: "State", kind: "state", placeholder: "FL" },
      { key: "tax_id_ein", label: "EIN / Federal Tax ID", kind: "text", placeholder: "12-3456789" },
      { key: "business_start_date", label: "Business start date", kind: "date", placeholder: "YYYY-MM-DD" },
      { key: "time_in_business_months", label: "Time in business (months)", kind: "int", placeholder: "24" },
      { key: "industry", label: "Industry", kind: "industry" },
      { key: "website", label: "Website", kind: "text", placeholder: "https://…" },
      { key: "product_service_description", label: "Product / service", kind: "text", wide: true },
    ],
  },
  {
    title: "Contact",
    fields: [
      { key: "contact_name", label: "Contact name", kind: "text" },
      { key: "email", label: "Email", kind: "email" },
      { key: "phone", label: "Phone", kind: "phone" },
    ],
  },
  {
    title: "Owner",
    fields: [
      { key: "owner_full_name", label: "Owner full name", kind: "text" },
      { key: "owner_ownership_pct", label: "Ownership %", kind: "pct", placeholder: "100" },
      { key: "owner_ssn", label: "SSN", kind: "ssn", placeholder: "123-45-6789", sensitive: true },
      { key: "owner_dob", label: "Date of birth", kind: "date", placeholder: "YYYY-MM-DD", sensitive: true },
      { key: "owner_cell", label: "Cell", kind: "phone" },
      { key: "owner_home_address", label: "Home address", kind: "address", wide: true },
    ],
  },
  {
    title: "Partner",
    hint: "Leave blank if there is no second owner.",
    fields: [
      { key: "partner_full_name", label: "Partner full name", kind: "text" },
      { key: "partner_ownership_pct", label: "Ownership %", kind: "pct" },
      { key: "partner_ssn", label: "SSN", kind: "ssn", placeholder: "123-45-6789", sensitive: true },
      { key: "partner_dob", label: "Date of birth", kind: "date", placeholder: "YYYY-MM-DD", sensitive: true },
      { key: "partner_cell", label: "Cell", kind: "phone" },
      { key: "partner_home_address", label: "Home address", kind: "address", wide: true },
    ],
  },
  {
    title: "Funding",
    fields: [
      { key: "monthly_revenue", label: "Monthly revenue", kind: "money", placeholder: "45000" },
      { key: "requested_amount", label: "Requested amount", kind: "money", placeholder: "50000" },
      { key: "desired_product", label: "Desired product", kind: "text", placeholder: "Working capital…" },
      { key: "applicant_fico", label: "FICO", kind: "int", placeholder: "680" },
      { key: "position_count", label: "Open positions", kind: "int", placeholder: "0" },
    ],
  },
];

const ALL_FIELDS: FieldDef[] = SECTIONS.flatMap((s) => s.fields);

/** Full US state name → USPS code (mirrors lib/forms/application-upsert.ts,
 *  which is server-only and can't be imported into this client component). */
const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};

function toDisplay(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && isFinite(v)) return String(v);
  if (typeof v === "string") return v;
  return "";
}

/** Snapshot the form-relevant keys of a data record as display strings. */
function snapshot(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ALL_FIELDS) out[f.key] = toDisplay(data[f.key]);
  return out;
}

/** Repo normPhone convention (lib/import/service.ts): bare digits, leading
 *  country-1 stripped from 11-digit numbers → 10-digit US storage. */
function normPhoneDigits(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** Accept YYYY-MM-DD or MM/DD/YYYY; return canonical YYYY-MM-DD or null. */
function toIsoDate(raw: string): string | null {
  const v = raw.trim();
  let y: number, m: number, d: number;
  let mm = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mm) {
    y = Number(mm[1]); m = Number(mm[2]); d = Number(mm[3]);
  } else {
    mm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!mm) return null;
    y = Number(mm[3]); m = Number(mm[1]); d = Number(mm[2]);
  }
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

type NormResult = { ok: true; value: string | number | null } | { ok: false; error: string };

/** Normalize a CHANGED field for the PATCH. Empty string clears (→ null). */
function normalizeField(def: FieldDef, raw: string, businessState = ""): NormResult {
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  switch (def.kind) {
    case "email": {
      const e = v.toLowerCase();
      if (!/\S+@\S+\.\S+/.test(e)) return { ok: false, error: "Enter a valid email address." };
      return { ok: true, value: e };
    }
    case "address": {
      // Only CHANGED fields reach normalizeField, and that is the whole design.
      // ~1,000 existing applications carry a partial address; re-validating them
      // would block an operator from editing an unrelated field on a record they
      // did not break. An address the operator actually TOUCHES must come out
      // complete, so editing can only improve the data, never add a new bare
      // street line. Same rule as the merchant form (lib/address/us-address.ts).
      const gate = isAcceptableCaptureAddress(
        v,
        def.key === "business_address" ? businessState : undefined,
      );
      if (!gate.ok) return { ok: false, error: gate.message };
      return { ok: true, value: v };
    }
    case "phone": {
      const digits = normPhoneDigits(v);
      if (digits.length < 7 || digits.length > 15) {
        return { ok: false, error: "Enter a valid phone number (at least 7 digits)." };
      }
      return { ok: true, value: digits };
    }
    case "money": {
      const n = parseFloat(v.replace(/[$,\s]/g, ""));
      if (isNaN(n) || !isFinite(n) || n < 0) {
        return { ok: false, error: "Enter a number, e.g. 45000." };
      }
      return { ok: true, value: n };
    }
    case "pct": {
      const n = parseInt(v.replace(/[%,\s]/g, ""), 10);
      if (isNaN(n) || n < 0 || n > 100) return { ok: false, error: "Enter 0-100." };
      return { ok: true, value: n };
    }
    case "int": {
      const n = parseInt(v.replace(/[,\s]/g, ""), 10);
      if (isNaN(n) || n < 0) return { ok: false, error: "Enter a whole number." };
      return { ok: true, value: n };
    }
    case "date": {
      const iso = toIsoDate(v);
      if (!iso) return { ok: false, error: "Use YYYY-MM-DD (or MM/DD/YYYY)." };
      return { ok: true, value: iso };
    }
    case "ssn": {
      if (v.replace(/\D+/g, "").length !== 9) {
        return { ok: false, error: "SSN must be 9 digits." };
      }
      return { ok: true, value: v };
    }
    case "state": {
      if (/^[A-Za-z]{2}$/.test(v)) return { ok: true, value: v.toUpperCase() };
      const code = US_STATE_NAME_TO_CODE[v.toLowerCase()];
      if (!code) return { ok: false, error: "Use the 2-letter state code, e.g. FL." };
      return { ok: true, value: code };
    }
    case "industry":
      return { ok: true, value: v.toLowerCase() };
    default:
      return { ok: true, value: v };
  }
}

/**
 * Mirror changed canonical keys onto their whitelisted alias keys, exactly as
 * application-upsert FIELD_ALIASES does on every form submission:
 * business_legal_name → business_name (drawer title / resolveTitle reads it),
 * owner_full_name → owner_name (drawer "Owner / Signer" reads it). Both are in
 * APPLICATION_FIELD_KEYS, so the edit route accepts them. No other mirrors —
 * the route rejects non-whitelisted keys (all-or-nothing).
 */
function applyAliasMirrors(patch: Record<string, string | number | null>): void {
  if ("business_legal_name" in patch) patch.business_name = patch.business_legal_name;
  if ("owner_full_name" in patch) patch.owner_name = patch.owner_full_name;
}

export function ApplicationEditForm({
  applicationId,
  data,
  onSaved,
  onCancel,
  onViewDocs,
}: {
  tenantSlug?: string;
  applicationId: string;
  data: Record<string, unknown>;
  onSaved: (nextData: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
  /** Optional: parent switches to the Docs tab (fresh PDF affordance). */
  onViewDocs?: () => void;
}) {
  // Snapshot once on mount — a parent reload mid-edit must not clobber typing.
  const [baseline, setBaseline] = useState<Record<string, string>>(() => snapshot(data));
  const [draft, setDraft] = useState<Record<string, string>>(() => snapshot(data));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [regenWarning, setRegenWarning] = useState<string | null>(null);

  const busy = phase === "saving";
  const dirtyKeys = ALL_FIELDS.filter((f) => (draft[f.key] ?? "") !== (baseline[f.key] ?? ""));

  function setField(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
    // Editing again after a save drops back to the idle state.
    setPhase((p) => (p === "success" ? "idle" : p));
    setSaveError(null);
  }

  async function handleSave() {
    if (busy || dirtyKeys.length === 0) return;
    setSaveError(null);
    setRegenWarning(null);

    // Validate + normalize CHANGED keys only.
    const nextErrors: Record<string, string> = {};
    const patch: Record<string, string | number | null> = {};
    for (const f of dirtyKeys) {
      // The business address holds its state in a SEPARATE field, so the gate
      // needs it or a legitimate "123 Biscayne Blvd, Miami, 33101" + state=FL —
      // which the merchant form and the renderer both accept — would be
      // rejected here as stateless. Read the draft so an unsaved state edit in
      // the same session counts. (Codex P2.)
      const res = normalizeField(f, draft[f.key] ?? "", draft.business_state ?? "");
      if (res.ok) patch[f.key] = res.value;
      else nextErrors[f.key] = res.error;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    applyAliasMirrors(patch);

    // ONE call: the edit route saves the patch atomically AND regenerates the
    // application PDF server-side before responding (pdf.regenerated tells us
    // whether the fresh document was filed).
    setPhase("saving");
    try {
      const r = await fetch(`/api/applications/${encodeURIComponent(applicationId)}/edit`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        record?: { data?: Record<string, unknown> } | null;
        pdf?: { regenerated?: boolean; document_id?: string | null; error?: string };
      };
      if (!r.ok || j.ok !== true) {
        setSaveError(j.message || j.error || `save_failed_${r.status}`);
        setPhase("idle");
        return; // keep the form open with the operator's edits intact
      }
      const mergedData: Record<string, unknown> =
        j.record?.data && typeof j.record.data === "object"
          ? j.record.data
          : { ...data, ...patch };

      // Re-baseline so the next edit diffs against what's now saved.
      const nextSnap = snapshot(mergedData);
      setBaseline(nextSnap);
      setDraft(nextSnap);
      setErrors({});
      setRegenWarning(
        j.pdf?.regenerated === true ? null : j.pdf?.error || "pdf_regeneration_failed",
      );
      setPhase("success");
      // Fires regardless of the pdf outcome — the record IS saved either way.
      await onSaved(mergedData);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "network_error");
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-4">
      {/* Editor header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
            Edit application
          </div>
          <div className="text-[11px] text-fg-dim mt-0.5 leading-relaxed">
            Complete &amp; Save updates the record and regenerates the application PDF.
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="shrink-0 text-[11px] text-fg-dim hover:text-fg px-1 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {/* Sections */}
      {SECTIONS.map((section) => (
        <div key={section.title} className="rounded-lg border border-bg-border bg-bg-deep/40 p-3.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-3">
            {section.title}
          </div>
          {section.hint && (
            <div className="text-[11px] text-fg-dim italic -mt-2 mb-3">{section.hint}</div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5">
            {section.fields.map((f) => (
              <div key={f.key} className={f.wide ? "sm:col-span-2" : undefined}>
                <label
                  htmlFor={`app-edit-${f.key}`}
                  className="block text-[9.5px] uppercase tracking-wider text-fg-dim mb-1"
                >
                  {f.label}
                </label>
                <input
                  id={`app-edit-${f.key}`}
                  type="text"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  disabled={busy}
                  autoComplete={f.sensitive ? "off" : undefined}
                  spellCheck={false}
                  inputMode={
                    f.kind === "money" || f.kind === "pct" || f.kind === "int" ? "decimal" :
                    f.kind === "phone" ? "tel" :
                    f.kind === "email" ? "email" : undefined
                  }
                  className={`w-full rounded-md border bg-bg-deep px-2.5 py-2 text-[12px] text-fg placeholder:text-fg-dim disabled:opacity-60 ${
                    errors[f.key] ? "border-red-500/60" : "border-bg-border"
                  }`}
                />
                {errors[f.key] && (
                  <div className="mt-1 text-[10.5px] text-red-300">{errors[f.key]}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Save error — form stays open, edits intact */}
      {saveError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-[11px] text-red-200">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">Save failed: {saveError}</div>
        </div>
      )}

      {/* Post-save status */}
      {phase === "success" && !regenWarning && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-[11px] text-emerald-200">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            Saved — application PDF regenerated with your changes.
            {onViewDocs ? (
              <button
                type="button"
                onClick={onViewDocs}
                className="ml-2 inline-flex items-center gap-1 font-semibold text-emerald-300 underline underline-offset-2 hover:no-underline"
              >
                <FileText className="w-3 h-3" />
                View in Docs
              </button>
            ) : (
              <span className="ml-1 text-emerald-300/80">The Docs tab has the fresh PDF.</span>
            )}
          </div>
        </div>
      )}
      {phase === "success" && regenWarning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            Saved — PDF regeneration failed: {regenWarning}. Use the Docs tab&apos;s
            Regenerate button to retry.
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-[11px] text-fg-dim">
          {busy
            ? "Saving + regenerating PDF…"
            : dirtyKeys.length > 0
              ? `${dirtyKeys.length} field${dirtyKeys.length === 1 ? "" : "s"} changed`
              : phase === "success"
                ? "All changes saved"
                : "No changes yet"}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {phase === "success" && (
            <button
              type="button"
              onClick={onCancel}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:border-fg-dim transition-colors"
            >
              Done
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || dirtyKeys.length === 0}
            className="inline-flex items-center gap-1.5 text-[12px] font-bold px-3.5 py-1.5 rounded-md bg-accent text-bg-deep hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {busy ? "Saving + regenerating PDF…" : "Complete & Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
