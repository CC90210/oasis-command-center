/**
 * lib/forms/responses.ts - the answers people sent in on one form, for the
 * Responses page (app/forms/[id]/responses) and its CSV download
 * (app/api/forms/[id]/responses). MKT-05, 2026-10-02.
 *
 * WHY. form_submissions kept every answer (OASIS's own audit form had 20) and
 * nothing in Forms showed them: the only way to read one was the database.
 *
 * SCOPE. The caller passes the workspace it took from the verified session
 * (lib/forms/access.ts). The form is read by id AND tenant first, so another
 * workspace's form id is "not found"; the submissions read repeats the tenant
 * predicate, so a row filed under another workspace never shows, even if it
 * names this form's id. Lead names are read the same way.
 *
 * WHAT A ROW IS. A multi-step form files one row per step it receives, so a
 * row is "one step someone submitted", labelled with that step's title.
 *
 * WHAT IS NEVER PRINTED. A drawn signature is an image: it reads "Signed". A
 * file reads as its file name. A field whose name says it holds a government
 * or bank number (SSN, SIN, tax id, account, routing or card number) shows only
 * its last four characters, the way the lead page shows an SSN. The page and
 * the CSV share answerText, so the two can never disagree on this.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFormSteps, type FormField, type FormStep } from "@/lib/forms/types";

export const RESPONSES_PAGE_SIZE = 25;
/** The CSV holds at most this many rows, newest first. */
export const RESPONSES_EXPORT_LIMIT = 5000;
const EXPORT_CHUNK = 500;
const LEAD_CHUNK = 100;
const MAX_ANSWER_CHARS = 2000;

export type ResponsesForm = { id: string; slug: string; name: string; steps: FormStep[] };

export type ResponseAnswer = { key: string; label: string; value: string };

export type FormResponse = {
  id: string;
  /** As stored: an ISO timestamp. */
  submittedAt: string;
  stepIndex: number;
  /** "Step 2 of 4: Your business", or "Step 2" when the form no longer has it. */
  stepLabel: string;
  leadId: string;
  /** Non-empty answers: this step's fields in form order, then any other keys. */
  answers: ResponseAnswer[];
};

const SUBMISSION_COLUMNS = "id, lead_id, step_index, payload, submitted_at";

type SubmissionRow = {
  id: string;
  lead_id: string | null;
  step_index: number | string | null;
  payload: unknown;
  submitted_at: string;
};

/** A stored definition that no longer parses still lists its answers, by key. */
function tolerantSteps(raw: unknown): FormStep[] {
  try {
    return parseFormSteps(raw);
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** This workspace's form, or null when the id is not one of its forms. Throws on a failed read. */
export async function loadResponsesForm(
  db: SupabaseClient,
  tenantId: string,
  formId: string,
): Promise<ResponsesForm | null> {
  const { data, error } = await db
    .from("forms")
    .select("id, slug, name, steps")
    .eq("id", formId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`form read failed: ${error.message}`);
  if (!data) return null;
  const row = data as { id: string; slug: string; name: string | null; steps: unknown };
  return { id: row.id, slug: row.slug, name: row.name || "Untitled form", steps: tolerantSteps(row.steps) };
}

/**
 * Answer counts for the Forms list, one per form id. null where the count
 * could not be read: the list says so instead of showing a zero.
 */
export async function countResponsesByForm(
  db: SupabaseClient,
  tenantId: string,
  formIds: string[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  // Four counts in flight at most (one request, bounded libSQL concurrency).
  for (let i = 0; i < formIds.length; i += 4) {
    const chunk = formIds.slice(i, i + 4);
    const counts = await Promise.all(
      chunk.map(async (formId) => {
        try {
          const { count, error } = await db
            .from("form_submissions")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .eq("form_id", formId);
          if (error || typeof count !== "number") {
            console.error("[forms.responses.count]", { tenantId, formId }, error?.message ?? "no count");
            return null;
          }
          return count;
        } catch (err) {
          console.error("[forms.responses.count] threw", { tenantId, formId }, err);
          return null;
        }
      }),
    );
    chunk.forEach((formId, idx) => {
      out[formId] = counts[idx];
    });
  }
  return out;
}

/** One page of a form's responses, newest first. Throws on a failed read. */
export async function loadResponsesPage(
  db: SupabaseClient,
  input: { tenantId: string; form: ResponsesForm; page: number },
): Promise<{ rows: FormResponse[]; total: number | null; page: number; pageCount: number }> {
  const page = Number.isFinite(input.page) && input.page >= 1 ? Math.floor(input.page) : 1;
  const from = (page - 1) * RESPONSES_PAGE_SIZE;
  const { data, error, count } = await db
    .from("form_submissions")
    .select(SUBMISSION_COLUMNS, { count: "exact" })
    .eq("tenant_id", input.tenantId)
    .eq("form_id", input.form.id)
    .order("submitted_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + RESPONSES_PAGE_SIZE - 1);
  if (error) throw new Error(`responses read failed: ${error.message}`);
  const rows = ((data || []) as SubmissionRow[]).map((r) => toResponse(input.form.steps, r));
  const total = typeof count === "number" ? count : null;
  const pageCount = total === null ? page : Math.max(1, Math.ceil(total / RESPONSES_PAGE_SIZE));
  return { rows, total, page, pageCount };
}

/** Every response for the CSV, newest first, up to RESPONSES_EXPORT_LIMIT. Throws on a failed read. */
export async function loadResponsesForExport(
  db: SupabaseClient,
  input: { tenantId: string; form: ResponsesForm },
): Promise<{ rows: FormResponse[]; total: number | null }> {
  const rows: FormResponse[] = [];
  let total: number | null = null;
  for (let from = 0; from < RESPONSES_EXPORT_LIMIT; from += EXPORT_CHUNK) {
    const to = Math.min(from + EXPORT_CHUNK, RESPONSES_EXPORT_LIMIT) - 1;
    const { data, error, count } = await db
      .from("form_submissions")
      .select(SUBMISSION_COLUMNS, from === 0 ? { count: "exact" } : undefined)
      .eq("tenant_id", input.tenantId)
      .eq("form_id", input.form.id)
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    if (error) throw new Error(`responses export read failed: ${error.message}`);
    if (from === 0 && typeof count === "number") total = count;
    const batch = (data || []) as SubmissionRow[];
    for (const r of batch) rows.push(toResponse(input.form.steps, r));
    if (batch.length < to - from + 1) break;
  }
  return { rows, total };
}

/**
 * Names for the leads these responses are linked to, from this workspace's
 * records only. A lead that is no longer on file is simply absent from the
 * map. Throws on a failed read.
 */
export async function loadLeadNames(
  db: SupabaseClient,
  tenantId: string,
  leadIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(leadIds.filter((id) => typeof id === "string" && id))];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LEAD_CHUNK) {
    const { data, error } = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + LEAD_CHUNK));
    if (error) throw new Error(`lead names read failed: ${error.message}`);
    for (const r of (data || []) as Array<{ id: string; data: unknown }>) out.set(r.id, leadName(r.data));
  }
  return out;
}

function leadName(data: unknown): string {
  const d = asRecord(data);
  for (const key of ["name", "contact_name", "full_name", "company", "business_name", "email"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "Unnamed lead";
}

function toResponse(steps: FormStep[], r: SubmissionRow): FormResponse {
  const stepIndex = Number(r.step_index) || 0;
  return {
    id: r.id,
    submittedAt: r.submitted_at,
    stepIndex,
    stepLabel: stepLabel(steps, stepIndex),
    leadId: r.lead_id || "",
    answers: answersFor(steps, stepIndex, r.payload),
  };
}

export function stepLabel(steps: FormStep[], stepIndex: number): string {
  const step = steps[stepIndex];
  return step ? `Step ${stepIndex + 1} of ${steps.length}: ${step.title}` : `Step ${stepIndex + 1}`;
}

/** Every field of the form, by name, first definition wins. */
function fieldsByName(steps: FormStep[]): Map<string, FormField> {
  const out = new Map<string, FormField>();
  for (const step of steps) for (const f of step.fields) if (!out.has(f.name)) out.set(f.name, f);
  return out;
}

/** This step's answers in the form's own order, then any key the form no longer defines. */
export function answersFor(steps: FormStep[], stepIndex: number, payload: unknown): ResponseAnswer[] {
  const values = asRecord(payload);
  const byName = fieldsByName(steps);
  const out: ResponseAnswer[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    seen.add(key);
    const field = byName.get(key);
    const value = answerText(key, field, values[key]);
    if (value) out.push({ key, label: field?.label || key, value });
  };
  for (const f of steps[stepIndex]?.fields ?? []) if (f.name in values) push(f.name);
  for (const key of Object.keys(values).sort()) if (!seen.has(key)) push(key);
  return out;
}

const SENSITIVE_FIELD =
  /(^|_)(ssn|sin|social_security|social_insurance|itin|tax_id|tin|account_number|routing_number|transit_number|card_number|cvv|cvc|password)(_|$)/i;

function isFile(value: unknown): value is { filename: string } {
  return !!value && typeof value === "object" && typeof (value as { filename?: unknown }).filename === "string";
}

function fileText(files: Array<{ filename: string }>): string {
  const names = files.map((f) => f.filename.trim() || "unnamed file");
  return `${names.length} file${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}

function optionText(field: FormField | undefined, value: string): string {
  return field?.options?.find((o) => o.value === value)?.label ?? value;
}

function lastFour(value: string): string {
  const chars = value.replace(/[^0-9A-Za-z]/g, "");
  return chars.length > 4 ? `ends in ${chars.slice(-4)}` : "Hidden";
}

/** One answer as text: what the Responses page shows and the CSV holds. "" for no answer. */
export function answerText(key: string, field: FormField | undefined, raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (field?.type === "signature" || (typeof raw === "string" && /^data:image\//i.test(raw.trim()))) {
    return typeof raw === "string" && raw.trim() ? "Signed" : "";
  }
  if (isFile(raw)) return fileText([raw]);
  if (Array.isArray(raw)) {
    if (raw.length === 0) return "";
    if (raw.every(isFile)) return fileText(raw);
    return clip(
      raw
        .map((v) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? optionText(field, String(v)) : JSON.stringify(v)))
        .filter(Boolean)
        .join(", "),
    );
  }
  if (typeof raw === "object") return clip(JSON.stringify(raw));
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  const text = String(raw).trim();
  if (!text) return "";
  if (SENSITIVE_FIELD.test(key)) return lastFour(text);
  return clip(optionText(field, text));
}

function clip(text: string): string {
  return text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}...` : text;
}

/**
 * A CSV cell. Quoted always; a value a spreadsheet would run as a formula
 * (=, +, -, @, tab, return) is prefixed with ' so it opens as text: these
 * answers are typed by strangers into a public form.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function isoUtc(stored: string): string {
  const ms = Date.parse(stored);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : stored;
}

/**
 * The CSV: when, step, lead, then one column per field of the form (its
 * label), then any key a response holds that the form no longer defines.
 */
export function responsesCsv(form: ResponsesForm, rows: FormResponse[], leadNames: Map<string, string> | null): string {
  const columns: Array<{ key: string; label: string }> = [];
  const known = new Set<string>();
  for (const step of form.steps) {
    for (const f of step.fields) {
      if (known.has(f.name)) continue;
      known.add(f.name);
      columns.push({ key: f.name, label: f.label || f.name });
    }
  }
  const extra = new Set<string>();
  for (const r of rows) for (const a of r.answers) if (!known.has(a.key)) extra.add(a.key);
  for (const key of [...extra].sort()) columns.push({ key, label: key });
  // Two fields can share a label; the field's own key tells them apart.
  const labelCount = new Map<string, number>();
  for (const c of columns) labelCount.set(c.label, (labelCount.get(c.label) ?? 0) + 1);
  const header = [
    "Submitted at (UTC)",
    "Step",
    "Lead",
    "Lead id",
    ...columns.map((c) => ((labelCount.get(c.label) ?? 0) > 1 ? `${c.label} (${c.key})` : c.label)),
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const byKey = new Map(r.answers.map((a) => [a.key, a.value]));
    const lead = leadNames === null ? "" : leadNames.get(r.leadId) ?? "No longer on file";
    lines.push(
      [isoUtc(r.submittedAt), r.stepLabel, lead, r.leadId, ...columns.map((c) => byKey.get(c.key) ?? "")]
        .map(csvCell)
        .join(","),
    );
  }
  // A byte-order mark so a spreadsheet opens accented answers as UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}
