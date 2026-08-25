"use client";

/**
 * ImportWizard — multi-entity, multi-step CSV import flow.
 *
 * Steps:
 *   1. Pick entity (leads / applications / lenders / funded-deals)
 *   2. Paste or upload CSV
 *   3. Preview + override column mapping if auto-detect missed any
 *   4. Configure dedup keys + default source, run dry-run
 *   5. Confirm + commit (re-uses the dry-run-validated payload)
 *
 * Backend: POST /api/import/[entity], body { rows, dedup_by, default_source, dry_run }.
 * Idempotent — re-uploading the same file de-dupes against tenant's existing rows.
 */

import { useMemo, useRef, useState } from "react";
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Search,
  User as UserIcon,
  Building2,
  FileText,
  Trophy,
  Users as UsersIcon,
} from "lucide-react";
import {
  IMPORT_ENTITIES,
  getEntityDefinition,
  type EntityDefinition,
} from "@/lib/import/entities";
import {
  parseImportCsv,
  remapWithOverride,
  type ParseResult,
} from "@/lib/import/csv-parser";
import { combineCsvTexts } from "@/lib/csv-combine";

type ImportResponse = {
  ok: boolean;
  inserted?: number;
  skipped_duplicate?: number;
  skipped_malformed?: number;
  duplicate_keys?: string[];
  errors?: string[];
  message?: string;
  error?: string;
  dry_run?: boolean;
};

// Build C UI affordance — Result row from /api/merchants/fuzzy-match-batch.
// Lets the confirm step surface "this row's business name looks similar
// to an existing merchant" warnings so operators catch near-duplicates
// the exact-match dedup misses.
type FuzzyMatchRow = {
  record_id: string;
  entity_type: string;
  business_name: string;
  state: string | null;
  similarity: number;
  ein: string | null;
  email: string | null;
  phone: string | null;
};
type FuzzyBatchResult = {
  idx: number;
  matches: FuzzyMatchRow[];
};

type Step = "pick" | "upload" | "preview" | "confirm" | "done";

function IconFor({ name }: { name: EntityDefinition["icon"] }) {
  const cls = "w-5 h-5";
  switch (name) {
    case "user": return <UserIcon className={cls} />;
    case "building-2": return <Building2 className={cls} />;
    case "file-text": return <FileText className={cls} />;
    case "trophy": return <Trophy className={cls} />;
    case "users": return <UsersIcon className={cls} />;
  }
}

export function ImportWizard() {
  const [step, setStep] = useState<Step>("pick");
  const [entityKey, setEntityKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [csv, setCsv] = useState<string>("");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [defaultSource, setDefaultSource] = useState("csv_import");
  const [dedupBy, setDedupBy] = useState<string[]>([]);
  const [dryResult, setDryResult] = useState<ImportResponse | null>(null);
  const [finalResult, setFinalResult] = useState<ImportResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Build C — fuzzy-match suggestions in the confirm step. Populated
  // on-demand by clicking "Check for similar merchants"; kept as a
  // separate state so operators who don't care about it never pay the
  // round-trip cost.
  const [fuzzyResults, setFuzzyResults] = useState<FuzzyBatchResult[] | null>(null);
  const [fuzzyLoading, setFuzzyLoading] = useState(false);
  const [fuzzyError, setFuzzyError] = useState<string | null>(null);

  const entity = entityKey ? getEntityDefinition(entityKey) : null;

  // Reset wizard state when an operator changes entity.
  function pickEntity(key: string) {
    const def = getEntityDefinition(key);
    if (!def) return;
    setEntityKey(key);
    setDedupBy([...def.defaultDedupBy]);
    setCsv("");
    setParsed(null);
    setDryResult(null);
    setFinalResult(null);
    setError(null);
    setStep("upload");
  }

  function reset() {
    setStep("pick");
    setEntityKey(null);
    setCsv("");
    setParsed(null);
    setDryResult(null);
    setFinalResult(null);
    setError(null);
    setSubmitting(false);
    setFuzzyResults(null);
    setFuzzyLoading(false);
    setFuzzyError(null);
  }

  // Build C — call the batch fuzzy-match endpoint on the rows the
  // dry-run says will insert. We pick the first 50 (the endpoint cap)
  // so the operator sees the most-likely-conflict candidates without
  // an expensive multi-round trip. Only fires for entities that
  // actually have a business-name field — lenders are already deduped
  // by lender_name in the exact-match pass.
  async function runFuzzyCheck() {
    if (!entity || !parsed) return;
    if (!parsed.coveredFields.includes("business_name") && !parsed.coveredFields.includes("legal_name")) {
      setFuzzyError("This import doesn't include a business name column — nothing to check.");
      return;
    }
    setFuzzyLoading(true);
    setFuzzyError(null);
    try {
      const submitRows = parsed.mapped.slice(0, 50).map((row, idx) => ({
        idx,
        business_name:
          (typeof row.legal_name === "string" && row.legal_name) ||
          (typeof row.business_name === "string" && row.business_name) ||
          (typeof row.name === "string" && row.name) ||
          "",
        state:
          (typeof row.state === "string" && row.state) || null,
      }));
      const res = await fetch("/api/merchants/fuzzy-match-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: submitRows, threshold: 0.5, per_row_limit: 3 }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setFuzzyError(body.message || body.error || `HTTP ${res.status}`);
        return;
      }
      setFuzzyResults(body.results as FuzzyBatchResult[]);
    } catch (e) {
      setFuzzyError((e as Error).message);
    } finally {
      setFuzzyLoading(false);
    }
  }

  // ---- parser memo + diagnostics ----
  const recognizedCount = parsed?.colMap.filter((c) => c !== null).length ?? 0;
  const unrecognizedHeaders = useMemo(() => {
    if (!parsed) return [];
    return parsed.headers
      .map((h, i) => ({ h, mapped: parsed.colMap[i] }))
      .filter((x) => x.mapped === null)
      .map((x) => x.h);
  }, [parsed]);

  // ---- handlers ----
  // Multi-file import (2026-06-19): operators routinely split an export into
  // several CSVs and want to drag/select them all at once. Read every file and
  // concatenate the data rows under one header (repeated identical headers are
  // dropped) so they import as a single combined batch through the normal
  // parse → preview → dedupe pipeline.
  async function handleFiles(files: File[]) {
    if (!entity || files.length === 0) return;
    const oversize = files.find((f) => f.size > 25 * 1024 * 1024);
    if (oversize) {
      setError(`"${oversize.name}" is over 25 MB. Split it into smaller chunks.`);
      return;
    }
    const texts = await Promise.all(files.map((f) => f.text()));
    const combined = combineCsvTexts(texts);
    setCsv(combined);
    setParsed(parseImportCsv(combined, entity));
    setError(null);
    setStep("preview");
  }

  function handleCsvPaste(text: string) {
    if (!entity) return;
    setCsv(text);
    setParsed(parseImportCsv(text, entity));
    setError(null);
    if (text.trim()) setStep("preview");
  }

  function overrideColumnMap(idx: number, field: string | null) {
    if (!parsed) return;
    const next = [...parsed.colMap];
    next[idx] = field;
    setParsed(remapWithOverride(parsed, next));
  }

  async function runDryRun() {
    if (!entity || !parsed || parsed.mapped.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/${entity.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: parsed.mapped,
          dedup_by: dedupBy,
          default_source: defaultSource,
          dry_run: true,
        }),
      });
      const body = (await res.json()) as ImportResponse;
      if (!res.ok || !body.ok) {
        setError(body.message || body.error || `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      setDryResult(body);
      setStep("confirm");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function commitImport() {
    if (!entity || !parsed || parsed.mapped.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/${entity.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: parsed.mapped,
          dedup_by: dedupBy,
          default_source: defaultSource,
        }),
      });
      const body = (await res.json()) as ImportResponse;
      if (!res.ok || !body.ok) {
        setError(body.message || body.error || `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      setFinalResult(body);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // ===================== render =====================
  return (
    <div className="space-y-6">
      {/* Stepper */}
      <ol className="flex items-center gap-2 text-xs text-fg-muted">
        {[
          { id: "pick", label: "1. Pick" },
          { id: "upload", label: "2. Upload" },
          { id: "preview", label: "3. Preview" },
          { id: "confirm", label: "4. Confirm" },
          { id: "done", label: "5. Done" },
        ].map((s, i) => (
          <li
            key={s.id}
            className={
              "flex items-center gap-2 " +
              (step === s.id ? "text-fg font-semibold" : "")
            }
          >
            <span>{s.label}</span>
            {i < 4 && <ArrowRight className="w-3 h-3 opacity-50" />}
          </li>
        ))}
      </ol>

      {/* Step 1 — Pick */}
      {step === "pick" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {IMPORT_ENTITIES.map((e) => (
            <button
              key={e.key}
              onClick={() => pickEntity(e.key)}
              className="text-left rounded-xl border border-bg-border bg-bg-elev/40 hover:bg-bg-elev hover:border-accent/40 p-4 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-accent/10 text-accent p-2 mt-0.5">
                  <IconFor name={e.icon} />
                </div>
                <div>
                  <div className="font-semibold text-fg">{e.label}</div>
                  <div className="text-xs text-fg-muted mt-1 leading-relaxed">{e.description}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Step 2 — Upload */}
      {step === "upload" && entity && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={reset}
              className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
            >
              <ArrowLeft className="w-3 h-3" /> Change type
            </button>
            <span className="text-xs text-fg-muted">
              Importing as <span className="text-fg font-semibold">{entity.label}</span>
            </span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,text/csv,text/plain,.tsv"
            className="hidden"
            onChange={(e) => {
              const fs = Array.from(e.target.files ?? []);
              if (fs.length) void handleFiles(fs);
              e.target.value = ""; // allow re-selecting the same file(s)
            }}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const fs = Array.from(e.dataTransfer?.files ?? []);
              if (fs.length) void handleFiles(fs);
            }}
            className={`w-full rounded-xl border border-dashed p-10 transition-colors flex flex-col items-center gap-3 ${
              dragging
                ? "border-accent bg-accent/10"
                : "border-bg-border hover:border-accent/40 bg-bg-elev/30 hover:bg-bg-elev/50"
            }`}
          >
            <Upload className="w-8 h-8 text-fg-dim" />
            <div className="text-sm text-fg-muted">
              Drop one or more CSVs here — or click to browse (select multiple to combine)
            </div>
          </button>

          <div className="text-xs text-fg-muted text-center">— or —</div>

          <div>
            <label className="text-xs text-fg-muted block mb-2">Paste CSV directly</label>
            <textarea
              value={csv}
              onChange={(e) => handleCsvPaste(e.target.value)}
              placeholder={entity.sampleCsv}
              rows={6}
              className="w-full bg-bg-elev/40 border border-bg-border rounded-lg p-3 text-xs font-mono text-fg placeholder:text-fg-dim resize-y"
            />
            <button
              onClick={() => handleCsvPaste(entity.sampleCsv)}
              className="mt-2 text-xs text-accent hover:underline inline-flex items-center gap-1"
            >
              <FileSpreadsheet className="w-3 h-3" /> Load sample
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Preview + column override */}
      {step === "preview" && entity && parsed && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs">
            <button onClick={() => setStep("upload")} className="text-fg-muted hover:text-fg inline-flex items-center gap-1">
              <ArrowLeft className="w-3 h-3" /> Back
            </button>
            <span className="text-fg-muted">
              <span className="text-fg font-semibold">{parsed.mapped.length}</span> data rows ·
              <span className="text-fg font-semibold ml-1">{recognizedCount}</span>/{parsed.headers.length} columns recognized
            </span>
          </div>

          {parsed.skippedPreambleRows > 0 && (
            <div className="text-xs text-fg-muted">
              Skipped {parsed.skippedPreambleRows} preamble row(s) above the header.
            </div>
          )}
          {parsed.skippedNoiseRows > 0 && (
            <div className="text-xs text-fg-muted">
              Skipped {parsed.skippedNoiseRows} blank / section / total row(s).
              {parsed.sectionLabels.length > 0 && (
                <> Sections noted: {parsed.sectionLabels.slice(0, 5).join(", ")}{parsed.sectionLabels.length > 5 ? "…" : ""}</>
              )}
            </div>
          )}

          {/* Column mapping override panel — only show unrecognized */}
          {unrecognizedHeaders.length > 0 && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
              <div className="flex items-center gap-2 text-yellow-400 text-sm font-semibold mb-2">
                <AlertCircle className="w-4 h-4" /> {unrecognizedHeaders.length} column(s) not recognized
              </div>
              <p className="text-xs text-fg-muted mb-3">
                Pick a target field for each — or leave blank to skip the column on import.
              </p>
              <div className="space-y-2">
                {parsed.headers.map((h, idx) =>
                  parsed.colMap[idx] !== null ? null : (
                    <div key={idx} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-fg-muted w-1/3 truncate">{h}</span>
                      <ArrowRight className="w-3 h-3 text-fg-dim" />
                      <select
                        value={parsed.colMap[idx] ?? ""}
                        onChange={(e) => overrideColumnMap(idx, e.target.value || null)}
                        className="bg-bg-elev border border-bg-border rounded px-2 py-1 text-xs text-fg flex-1"
                      >
                        <option value="">(skip)</option>
                        {entity.canonicalFields.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}

          {/* Preview table — first 5 mapped rows */}
          <div className="overflow-x-auto rounded-lg border border-bg-border">
            <table className="w-full text-xs">
              <thead className="bg-bg-elev/60 text-fg-muted">
                <tr>
                  {entity.canonicalFields
                    .filter((f) => parsed.coveredFields.includes(f.key))
                    .map((f) => (
                      <th key={f.key} className="text-left px-3 py-2 font-medium whitespace-nowrap">{f.label}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {parsed.mapped.slice(0, 5).map((row, idx) => (
                  <tr key={idx} className="border-t border-bg-border">
                    {entity.canonicalFields
                      .filter((f) => parsed.coveredFields.includes(f.key))
                      .map((f) => (
                        <td key={f.key} className="px-3 py-2 text-fg whitespace-nowrap max-w-[180px] truncate">
                          {row[f.key] ?? <span className="text-fg-dim">—</span>}
                        </td>
                      ))}
                  </tr>
                ))}
                {parsed.mapped.length > 5 && (
                  <tr><td colSpan={parsed.coveredFields.length} className="px-3 py-2 text-fg-muted text-center text-xs italic">…and {parsed.mapped.length - 5} more</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Dedup + source config */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border border-bg-border bg-bg-elev/30 p-4">
            <div>
              <div className="text-xs text-fg-muted mb-2">Dedup against existing rows by:</div>
              <div className="space-y-1.5">
                {entity.defaultDedupBy.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-xs text-fg">
                    <input
                      type="checkbox"
                      checked={dedupBy.includes(k)}
                      onChange={(e) =>
                        setDedupBy(
                          e.target.checked
                            ? [...dedupBy, k]
                            : dedupBy.filter((x) => x !== k),
                        )
                      }
                    />
                    {k.replace("_", " ")}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-muted mb-2">Tag every imported row with source:</div>
              <input
                type="text"
                value={defaultSource}
                onChange={(e) => setDefaultSource(e.target.value)}
                className="w-full bg-bg-elev border border-bg-border rounded px-2 py-1 text-xs text-fg"
                placeholder="csv_import"
              />
            </div>
          </div>

          {error && <div className="text-sm text-red-400">⚠ {error}</div>}

          <div className="flex justify-end gap-2">
            <button
              onClick={runDryRun}
              disabled={submitting || parsed.mapped.length === 0 || recognizedCount === 0}
              className="btn-primary text-sm inline-flex items-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              Dry-run preview
            </button>
          </div>
        </div>
      )}

      {/* Step 4 — Confirm */}
      {step === "confirm" && entity && parsed && dryResult && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs">
            <button onClick={() => setStep("preview")} className="text-fg-muted hover:text-fg inline-flex items-center gap-1">
              <ArrowLeft className="w-3 h-3" /> Back
            </button>
            <span className="text-fg-muted">Dry-run complete — ready to commit</span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 text-center">
              <div className="text-2xl font-bold text-green-400">{parsed.mapped.length - (dryResult.skipped_duplicate ?? 0) - (dryResult.skipped_malformed ?? 0)}</div>
              <div className="text-xs text-fg-muted mt-1">will insert</div>
            </div>
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 text-center">
              <div className="text-2xl font-bold text-yellow-400">{dryResult.skipped_duplicate ?? 0}</div>
              <div className="text-xs text-fg-muted mt-1">duplicates skipped</div>
            </div>
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-center">
              <div className="text-2xl font-bold text-red-400">{dryResult.skipped_malformed ?? 0}</div>
              <div className="text-xs text-fg-muted mt-1">malformed skipped</div>
            </div>
          </div>

          {dryResult.errors && dryResult.errors.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
              <div className="text-xs font-semibold text-red-300 mb-2">Malformed row notes</div>
              <ul className="text-xs text-fg-muted space-y-1 list-disc list-inside">
                {dryResult.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {dryResult.duplicate_keys && dryResult.duplicate_keys.length > 0 && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
              <div className="text-xs font-semibold text-yellow-300 mb-2">Sample duplicate keys</div>
              <ul className="text-xs text-fg-muted space-y-1 list-disc list-inside max-h-40 overflow-y-auto">
                {dryResult.duplicate_keys.slice(0, 25).map((k, i) => <li key={i} className="font-mono">{k}</li>)}
              </ul>
            </div>
          )}

          {/* Build C — fuzzy merchant match suggestions. The exact-match
              dedup ABOVE catches identical entries; this catches "did
              you mean…?" cases — typos, entity-suffix drift, abbreviations. */}
          <div className="rounded-lg border border-bg-border bg-bg-elev/30 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-fg">Potential merchant matches</div>
                <div className="text-[11px] text-fg-muted mt-0.5">
                  Look for {entity.label.toLowerCase()} in your existing data whose business names
                  are similar (e.g. typos, &quot;Inc&quot; vs &quot;LLC&quot;). Catches near-duplicates the exact-match
                  dedup above misses.
                </div>
              </div>
              <button
                onClick={runFuzzyCheck}
                disabled={fuzzyLoading || parsed.mapped.length === 0}
                className="btn-secondary text-xs inline-flex items-center gap-1.5 shrink-0"
              >
                {fuzzyLoading
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning…</>
                  : <><Search className="w-3.5 h-3.5" /> Check first {Math.min(parsed.mapped.length, 50)} rows</>}
              </button>
            </div>
            {fuzzyError && <div className="text-xs text-red-400">⚠ {fuzzyError}</div>}
            {fuzzyResults && (() => {
              const flagged = fuzzyResults.filter((r) => r.matches.length > 0);
              if (flagged.length === 0) {
                return (
                  <div className="text-xs text-green-400 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> No similar merchants found — these all look new.
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  <div className="text-xs text-yellow-400 font-semibold">
                    {flagged.length} row{flagged.length === 1 ? "" : "s"} look similar to existing merchants:
                  </div>
                  <ul className="text-xs space-y-2 max-h-64 overflow-y-auto">
                    {flagged.slice(0, 20).map((r) => {
                      const row = parsed.mapped[r.idx];
                      const rowBiz =
                        (typeof row?.legal_name === "string" && row.legal_name) ||
                        (typeof row?.business_name === "string" && row.business_name) ||
                        (typeof row?.name === "string" && row.name) ||
                        `(row ${r.idx + 1})`;
                      const best = r.matches[0];
                      return (
                        <li key={r.idx} className="rounded border border-bg-border bg-bg-elev/40 p-2.5">
                          <div className="text-fg font-mono text-[11px] mb-1">
                            <span className="text-fg-muted">Row {r.idx + 1}:</span> {rowBiz}
                          </div>
                          <div className="text-fg-muted text-[11px] leading-relaxed">
                            ↳ <span className="text-yellow-300">{Math.round(best.similarity * 100)}% match</span>{" "}
                            against existing <span className="text-fg font-mono">{best.business_name}</span>
                            {best.state ? <> in {best.state}</> : null}
                            {best.ein ? <> · EIN ···{best.ein.slice(-4)}</> : null}
                          </div>
                          {r.matches.length > 1 && (
                            <div className="text-[10px] text-fg-dim mt-1">
                              + {r.matches.length - 1} other candidate{r.matches.length === 2 ? "" : "s"}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="text-[10px] text-fg-dim">
                    These are suggestions only — committing the import still inserts them.
                    Use this list to review + delete rows from your CSV before re-uploading
                    if any are actually duplicates.
                  </div>
                </div>
              );
            })()}
          </div>

          {error && <div className="text-sm text-red-400">⚠ {error}</div>}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setStep("preview")}
              disabled={submitting}
              className="btn-secondary text-sm"
            >
              Adjust mapping
            </button>
            <button
              onClick={commitImport}
              disabled={submitting}
              className="btn-primary text-sm inline-flex items-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Commit import
            </button>
          </div>
        </div>
      )}

      {/* Step 5 — Done */}
      {step === "done" && finalResult && entity && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-8 text-center space-y-3">
          <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto" />
          <h2 className="text-lg font-semibold text-fg">Import complete</h2>
          <p className="text-sm text-fg-muted">
            Inserted <span className="text-green-400 font-semibold">{finalResult.inserted}</span> new {entity.label.toLowerCase()}{(finalResult.inserted ?? 0) === 1 ? "" : ""} ·
            skipped <span className="font-semibold">{finalResult.skipped_duplicate ?? 0}</span> duplicate(s) ·
            skipped <span className="font-semibold">{finalResult.skipped_malformed ?? 0}</span> malformed
          </p>
          <div className="flex justify-center gap-2 pt-2">
            <button onClick={reset} className="btn-secondary text-sm inline-flex items-center gap-2">
              <RefreshCw className="w-4 h-4" /> Import another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
