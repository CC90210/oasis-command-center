"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Save,
  AlertCircle,
  Plus,
  X,
  Paperclip,
  Trash2,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import Link from "next/link";
import type { ManifestEntityDef, ManifestEntityField } from "@/lib/manifest/schema";
import { humanize } from "@/lib/manifest/humanize";
import { LEAD_DOC_TYPES, humanLeadDocSize } from "@/lib/lead-doc-display";
import { AddressAutocompleteField } from "@/components/forms/AddressAutocompleteField";

type Props = {
  tenantSlug: string;
  entity: ManifestEntityDef;
  /** Relative path of the page that brought us here (e.g. "applications").
   *  Used to compute the cancel/return link as `/t/${tenantSlug}/${backPath}`
   *  when `backHref` is not supplied. */
  backPath: string;
  /** Optional absolute href that overrides the computed `/t/${slug}/${backPath}`
   *  return URL. Used by empire-side pages like /pipeline that need to land
   *  back on `/pipeline`, not `/t/oasis/pipeline`. */
  backHref?: string;
  /** Optional pre-populated values for edit mode (Phase 5.1). */
  initial?: Record<string, unknown>;
  /** Optional record id for edit mode (Phase 5.1). */
  editId?: string;
};

type PendingDocument = {
  id: string;
  file: File;
  docType: string;
};

/**
 * Create-record form for a manifest entity. Renders one input per field
 * in the entity schema; submits to POST /api/manifest/<slug>/records/<entity>.
 *
 * Field-type → control mapping:
 *   string      → text input
 *   number      → number input
 *   boolean     → checkbox
 *   date        → date input
 *   datetime    → datetime-local input
 *   enum        → select (uses enum_values from the field def)
 *   json        → key-value editor with an Advanced (raw JSON) toggle
 *
 * Required fields render with an asterisk and HTML-level required=true.
 * Field names are humanized (snake_case → Title Case); the underlying
 * field type is intentionally NOT surfaced — operators don't need to
 * think about whether a field is a string or number. Per-field validation
 * errors render below each input (not in a single banner) so the
 * operator can fix them in place. Server-side validation in the records
 * API + RecordsError catches anything the client missed.
 */

/** Per-field example placeholder. Helps operators infer the expected shape
 *  without having to read the underlying type. Kept conservative — only
 *  fields with universally obvious examples get a placeholder; everything
 *  else falls back to the empty string. */
function placeholderFor(field: ManifestEntityField): string {
  const n = field.name.toLowerCase();
  if (field.type === "number") {
    if (n.includes("amount") || n.includes("revenue") || n.includes("funded") || n.includes("price")) return "25000";
    if (n.includes("rate") || n.includes("factor")) return "1.35";
    if (n.includes("months") || n.includes("term")) return "12";
    if (n.includes("fico") || n.includes("score")) return "650";
    return "";
  }
  if (field.type === "date" || field.type === "datetime") return "";
  if (n === "email" || n.endsWith("_email")) return "name@example.com";
  if (n === "phone" || n.endsWith("_phone")) return "+1 555 123 4567";
  if (n === "url" || n.endsWith("_url")) return "https://...";
  if (n === "first_name") return "Hunter";
  if (n === "last_name") return "Smith";
  if (n === "business_name" || n === "company") return "Hunter Construction Inc.";
  return "";
}

function newPendingDocumentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ManifestRecordForm({
  tenantSlug,
  entity,
  backPath,
  backHref,
  initial,
  editId,
}: Props) {
  const router = useRouter();
  const resolvedBackHref = backHref ?? `/t/${tenantSlug}/${backPath}`;
  const [values, setValues] = useState<Record<string, unknown>>(initial || {});
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [createdRecordId, setCreatedRecordId] = useState<string | null>(null);
  const [defaultDocType, setDefaultDocType] = useState("unclassified");
  const [pendingDocs, setPendingDocs] = useState<PendingDocument[]>([]);

  const persistedRecordId = editId || createdRecordId;
  const isEdit = !!persistedRecordId;
  const supportsDocuments = entity.name === "lead" || entity.name === "application";

  function setField(name: string, value: unknown) {
    setValues((v) => ({ ...v, [name]: value }));
    // Clear the field's error as soon as the operator edits it — feels
    // like a normal form, not a punitive one.
    if (fieldErrors[name]) {
      setFieldErrors((errs) => {
        const next = { ...errs };
        delete next[name];
        return next;
      });
    }
  }

  /** Build payload + per-field errors. Returns null when there are errors;
   *  the caller surfaces them inline. Server still re-validates. */
  function buildPayload(): { payload: Record<string, unknown> } | { errors: Record<string, string> } {
    const out: Record<string, unknown> = {};
    const errs: Record<string, string> = {};
    for (const f of entity.fields) {
      const raw = values[f.name];
      const empty = raw === undefined || raw === "" || raw === null;
      if (empty) {
        if (f.required) errs[f.name] = "Required";
        continue;
      }
      if (f.type === "number") {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          errs[f.name] = "Must be a number";
          continue;
        }
        out[f.name] = n;
      } else if (f.type === "boolean") {
        out[f.name] = !!raw;
      } else if (f.type === "json") {
        // JSON fields produce an object from the key-value editor. The
        // prior Advanced (raw JSON) mode is gone (2026-05-19 turnkey
        // pass) — any non-object value reaching this branch is legacy
        // data, pass it through unchanged.
        out[f.name] = raw;
      } else {
        out[f.name] = raw;
      }
    }
    if (Object.keys(errs).length > 0) return { errors: errs };
    return { payload: out };
  }

  function queueDocuments(files: FileList | null) {
    if (!files || files.length === 0) return;
    const next = Array.from(files).map((file) => ({
      id: newPendingDocumentId(),
      file,
      docType: defaultDocType,
    }));
    setPendingDocs((docs) => [...docs, ...next]);
  }

  function updatePendingDocument(id: string, docType: string) {
    setPendingDocs((docs) =>
      docs.map((doc) => (doc.id === id ? { ...doc, docType } : doc)),
    );
  }

  function removePendingDocument(id: string) {
    setPendingDocs((docs) => docs.filter((doc) => doc.id !== id));
  }

  async function uploadQueuedDocuments(
    recordId: string,
  ): Promise<{ error: string | null; uploadedIds: string[] }> {
    if (!supportsDocuments || pendingDocs.length === 0) return { error: null, uploadedIds: [] };
    const qs = entity.name === "application" ? "?entity=application" : "";
    const uploadedIds: string[] = [];
    for (const doc of pendingDocs) {
      const fd = new FormData();
      fd.append("file", doc.file);
      fd.append("doc_type", doc.docType);
      fd.append("source", "record_form_upload");
      const res = await fetch(`/api/leads/${recordId}/documents${qs}`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        return {
          error: `${doc.file.name}: ${data.error || `upload_failed_${res.status}`}`,
          uploadedIds,
        };
      }
      uploadedIds.push(doc.id);
    }
    return { error: null, uploadedIds };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setFieldErrors({});
    setFormError(null);
    setFlash(null);
    setSaving(true);

    const result = buildPayload();
    if ("errors" in result) {
      setFieldErrors(result.errors);
      setFormError("Fix the highlighted fields and try again.");
      setSaving(false);
      return;
    }

    try {
      const url = isEdit
        ? `/api/manifest/${tenantSlug}/records/${entity.name}?id=${encodeURIComponent(persistedRecordId!)}`
        : `/api/manifest/${tenantSlug}/records/${entity.name}`;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isEdit ? { patch: result.payload } : { data: result.payload }),
      });
      const data = (await res.json()) as
        | { ok: true; record: { id: string } }
        | { ok: false; error: string; message?: string };
      if (!data.ok) {
        setFormError(data.message || data.error);
        setSaving(false);
        return;
      }
      const savedId = data.record.id;
      if (!editId && savedId) setCreatedRecordId(savedId);

      const uploadedCount = pendingDocs.length;
      const uploadResult = await uploadQueuedDocuments(savedId);
      if (uploadResult.error) {
        setPendingDocs((docs) => docs.filter((doc) => !uploadResult.uploadedIds.includes(doc.id)));
        setFlash("Record saved.");
        setFormError(`File upload failed: ${uploadResult.error}`);
        setSaving(false);
        router.refresh();
        return;
      }

      setPendingDocs([]);
      setFlash(uploadedCount > 0
        ? `Saved and uploaded ${uploadedCount} file${uploadedCount === 1 ? "" : "s"}. Redirecting...`
        : "Saved. Redirecting...");
      router.push(resolvedBackHref);
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "network_error");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-bg-border bg-bg-elev/40 p-5">
      {entity.fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name]}
          error={fieldErrors[field.name] ?? null}
          onChange={(v) => setField(field.name, v)}
          disabled={saving}
        />
      ))}

      {supportsDocuments && (
        <DocumentQueue
          entityLabel={entity.label}
          defaultDocType={defaultDocType}
          pendingDocs={pendingDocs}
          disabled={saving}
          onDefaultDocTypeChange={setDefaultDocType}
          onQueueDocuments={queueDocuments}
          onUpdateDocType={updatePendingDocument}
          onRemove={removePendingDocument}
        />
      )}

      {flash && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100 inline-flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-0.5" />
          <span>{flash}</span>
        </div>
      )}
      {formError && (
        <div className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200 inline-flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <span>{formError}</span>
        </div>
      )}

      <div className="flex items-center gap-2 pt-3 border-t border-bg-border">
        <button
          type="submit"
          disabled={saving}
          className="btn-send inline-flex items-center gap-1.5 !px-4 !py-2 text-sm"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isEdit ? "Save changes" : `Create ${entity.label.toLowerCase()}`}
        </button>
        <Link
          href={resolvedBackHref}
          className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-2 text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          Cancel
        </Link>
      </div>
    </form>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
  disabled,
}: {
  field: ManifestEntityField;
  value: unknown;
  error: string | null;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const labelText = humanize(field.name);
  const label = (
    <span className="text-xs font-semibold text-fg block mb-1">
      {labelText}
      {field.required && <span className="ml-1 text-accent">*</span>}
    </span>
  );

  // Red ring when this field has a validation error. Otherwise the
  // standard ring + accent focus state.
  const ringClass = error
    ? "border-red-400/60 focus:border-red-400/80"
    : "border-bg-border focus:border-accent/50";
  const baseClass =
    `w-full rounded-xl border ${ringClass} bg-bg-deep/80 px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none disabled:opacity-50`;

  const placeholder = placeholderFor(field);

  // Inline error renderer — appears immediately below each input. Kept
  // out of the per-type branches so every field renders errors the same
  // way.
  const errorNode = error ? (
    <div className="text-[11px] text-red-300 mt-1 inline-flex items-center gap-1">
      <AlertCircle className="h-3 w-3" />
      <span>{error}</span>
    </div>
  ) : null;

  if (field.type === "enum" && field.enum_values && field.enum_values.length > 0) {
    return (
      <label className="block">
        {label}
        <select
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseClass}
        >
          <option value="">— pick one —</option>
          {field.enum_values.map((v) => (
            <option key={v} value={v}>
              {humanize(v)}
            </option>
          ))}
        </select>
        {errorNode}
      </label>
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span>
          {labelText}
          {field.required && <span className="ml-1 text-accent">*</span>}
        </span>
        {errorNode}
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label className="block">
        {label}
        <input
          type="number"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className={baseClass}
        />
        {errorNode}
      </label>
    );
  }
  if (field.type === "date") {
    return (
      <label className="block">
        {label}
        <input
          type="date"
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseClass}
        />
        {errorNode}
      </label>
    );
  }
  if (field.type === "datetime") {
    return (
      <label className="block">
        {label}
        <input
          type="datetime-local"
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseClass}
        />
        {errorNode}
      </label>
    );
  }
  if (field.type === "json") {
    return (
      <JsonField
        label={label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        baseClass={baseClass}
        errorNode={errorNode}
      />
    );
  }
  const n = field.name.toLowerCase();
  // Address fields get the same free (Photon/OSM, keyless) autocomplete the
  // public form uses, so employees entering a merchant's address get suggestions
  // too — not just merchants. Manifest fields are typed "string", so detect by
  // name (business_address, owner_home_address, mailing_address, …).
  if (n === "address" || n.endsWith("_address")) {
    return (
      <label className="block">
        {label}
        <AddressAutocompleteField
          inputId={field.name}
          value={(value as string) || ""}
          onChange={(v) => onChange(v)}
          placeholder={placeholder || "Start typing the address…"}
          className={baseClass}
        />
        {errorNode}
      </label>
    );
  }
  // string default — picks email/phone/url input mode from the field
  // name so the mobile keyboard surfaces the right keys.
  const inputType =
    n === "email" || n.endsWith("_email") ? "email"
    : n === "phone" || n.endsWith("_phone") ? "tel"
    : n === "url" || n.endsWith("_url") ? "url"
    : "text";
  return (
    <label className="block">
      {label}
      <input
        type={inputType}
        value={(value as string) || ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={baseClass}
      />
      {errorNode}
    </label>
  );
}

/**
 * Staged document/photo queue for lead and application records. Files
 * upload after the manifest record is saved.
 *
 * New records and edits use the same lead_documents backend path as
 * the drawer, which keeps document state in sync across both surfaces.
 */
function DocumentQueue({
  entityLabel,
  defaultDocType,
  pendingDocs,
  disabled,
  onDefaultDocTypeChange,
  onQueueDocuments,
  onUpdateDocType,
  onRemove,
}: {
  entityLabel: string;
  defaultDocType: string;
  pendingDocs: PendingDocument[];
  disabled?: boolean;
  onDefaultDocTypeChange: (docType: string) => void;
  onQueueDocuments: (files: FileList | null) => void;
  onUpdateDocType: (id: string, docType: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <section className="border-t border-bg-border pt-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
            Documents &amp; photos
          </h3>
          <div className="mt-1 font-mono text-[11px] text-fg-dim">
            {pendingDocs.length} queued for this {entityLabel.toLowerCase()}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-[220px]">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              Type
            </span>
            <select
              value={defaultDocType}
              onChange={(e) => onDefaultDocTypeChange(e.target.value)}
              disabled={disabled}
              className="w-full rounded-xl border border-bg-border bg-bg-deep/80 px-3 py-2 text-sm text-fg focus:border-accent/50 focus:outline-none disabled:opacity-50"
            >
              {LEAD_DOC_TYPES.map((docType) => (
                <option key={docType.key} value={docType.key}>
                  {docType.label}
                  {docType.required ? " *" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-xl border border-bg-border bg-bg-elev px-3 text-sm font-semibold text-fg hover:border-fg-dim hover:bg-bg-deep/80">
            <Paperclip className="h-4 w-4" />
            Add files
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.doc,.docx,.txt,.csv"
              disabled={disabled}
              className="sr-only"
              onChange={(e) => {
                onQueueDocuments(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {pendingDocs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-bg-border bg-bg-deep/30 px-3 py-3 text-center text-xs italic text-fg-dim">
          No files queued.
        </div>
      ) : (
        <ul className="space-y-2">
          {pendingDocs.map((doc) => {
            const isImage = doc.file.type.startsWith("image/");
            return (
              <li
                key={doc.id}
                className="grid gap-2 rounded-xl border border-bg-border bg-bg-deep/40 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-fg-dim">
                    {isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-fg" title={doc.file.name}>
                      {doc.file.name}
                    </div>
                    <div className="font-mono text-[10.5px] text-fg-dim">
                      {humanLeadDocSize(doc.file.size)}
                    </div>
                  </div>
                </div>
                <select
                  value={doc.docType}
                  onChange={(e) => onUpdateDocType(doc.id, e.target.value)}
                  disabled={disabled}
                  aria-label={`Document type for ${doc.file.name}`}
                  className="w-full rounded-lg border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg focus:border-accent/50 focus:outline-none disabled:opacity-50"
                >
                  {LEAD_DOC_TYPES.map((docType) => (
                    <option key={docType.key} value={docType.key}>
                      {docType.label}
                      {docType.required ? " *" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onRemove(doc.id)}
                  disabled={disabled}
                  className="inline-flex items-center justify-center rounded-lg border border-bg-border bg-bg-elev px-2 py-1.5 text-fg-dim hover:text-red-300 disabled:opacity-50"
                  title="Remove file"
                  aria-label={`Remove ${doc.file.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Editor for `type: "json"` fields. Turnkey key/value editor -- one row
 * per top-level key, plain text inputs. The committed value is always
 * an object.
 */
function JsonField({
  label,
  value,
  onChange,
  disabled,
  baseClass,
  errorNode,
}: {
  label: React.ReactNode;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  baseClass: string;
  errorNode: React.ReactNode;
}) {
  // Normalize the current value to a row list. Handles objects (the
  // common case) and falls back to an empty list for anything else.
  const initialRows = (() => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
        key: k,
        value: typeof v === "string" ? v : JSON.stringify(v),
      }));
    }
    return [] as { key: string; value: string }[];
  })();
  const [rows, setRows] = useState(initialRows);

  function rowsToObject(list: { key: string; value: string }[]): Record<string, string> {
    const obj: Record<string, string> = {};
    for (const r of list) {
      if (!r.key.trim()) continue;
      obj[r.key.trim()] = r.value;
    }
    return obj;
  }

  function commitRows(next: { key: string; value: string }[]) {
    setRows(next);
    onChange(rowsToObject(next));
  }

  return (
    <div className="block">
      <div className="mb-1">{label}</div>
      <div className="space-y-2">
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              value={row.key}
              onChange={(e) => {
                const next = [...rows];
                next[idx] = { ...row, key: e.target.value };
                commitRows(next);
              }}
              disabled={disabled}
              placeholder="key"
              className={`${baseClass} w-1/3`}
            />
            <input
              type="text"
              value={row.value}
              onChange={(e) => {
                const next = [...rows];
                next[idx] = { ...row, value: e.target.value };
                commitRows(next);
              }}
              disabled={disabled}
              placeholder="value"
              className={baseClass}
            />
            <button
              type="button"
              onClick={() => commitRows(rows.filter((_, i) => i !== idx))}
              disabled={disabled}
              className="shrink-0 p-1 text-fg-dim hover:text-red-300"
              title="Remove"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => commitRows([...rows, { key: "", value: "" }])}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <Plus className="h-3 w-3" /> Add field
        </button>
      </div>
      {errorNode}
    </div>
  );
}
