/**
 * Gmail (plain-text) template library — shared types, validation, and client
 * fetch helpers.
 *
 * This module is the single import surface for BOTH the Templates Library UI
 * and any email dispatch module (lead blasts, cold outreach) that wants to
 * inject a stored plain-text template: fetch the list via
 * `listGmailTemplates()` (or GET /api/gmail-templates server-side) and merge
 * `{{tokens}}` with `renderGmailTemplate()`.
 *
 * Format constraint: subject/body are STRICTLY plain text — `containsHtml`
 * is enforced here client-side for fast feedback and again server-side on
 * every write path.
 */

import { LEAD_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";

export type GmailTemplateVariant = {
  id: string;
  label: string;
  subject: string;
  body: string;
  /** Where the copy came from — today always "solara". */
  source: string;
  created_at: string;
};

export type GmailTemplate = {
  id: string;
  tenant_id: string;
  name: string;
  stage: string;
  subject: string;
  body: string;
  variants: GmailTemplateVariant[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type GmailTemplateStage = { key: string; label: string };

/** Every selectable stage: the lead pipeline stages + a catch-all bucket. */
export const GMAIL_TEMPLATE_STAGES: GmailTemplateStage[] = [
  { key: "general", label: "General / Any stage" },
  ...LEAD_PIPELINE_STAGES.map(({ key, label }) => ({ key, label })),
];

export const GMAIL_TEMPLATE_STAGE_KEYS = new Set(
  GMAIL_TEMPLATE_STAGES.map((s) => s.key),
);

export function gmailStageLabel(key: string): string {
  return GMAIL_TEMPLATE_STAGES.find((s) => s.key === key)?.label ?? key;
}

export const GMAIL_SUBJECT_MAX = 200;
export const GMAIL_BODY_MAX = 20000;
export const GMAIL_NAME_MAX = 120;
export const GMAIL_VARIANTS_MAX = 12;

/** True when the text smells like markup — an opening/closing tag start.
 *  Plain prose comparisons like "revenue < 50k" don't trip it. */
export function containsHtml(text: string): boolean {
  return /<\s*\/?\s*[a-z!][a-z0-9-]*(\s|>|\/)/i.test(text);
}

/** `{{token}}` merge fields present in a template, sorted + deduped. */
export function extractGmailTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    tokens.add(match[1]);
  }
  return [...tokens].sort((a, b) => a.localeCompare(b));
}

/** Merge `{{tokens}}` into a template string. Unknown tokens render as
 *  `[token]` so a half-merged email is visibly unfinished, never silently
 *  wrong. This is the renderer the dispatch module should use. */
export function renderGmailTemplate(
  text: string,
  fields: Record<string, string>,
): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, token: string) =>
    fields[token] != null && fields[token] !== "" ? fields[token] : `[${token}]`,
  );
}

// ── Client fetch helpers (plain fetch + JSON, the house pattern) ───────────

type ApiErr = { ok: false; error: string; message?: string; hits?: string[] };

export async function listGmailTemplates(): Promise<
  { ok: true; templates: GmailTemplate[] } | ApiErr
> {
  try {
    const res = await fetch("/api/gmail-templates", { cache: "no-store" });
    return (await res.json()) as { ok: true; templates: GmailTemplate[] } | ApiErr;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function createGmailTemplate(input: {
  name: string;
  stage: string;
  subject: string;
  body: string;
}): Promise<{ ok: true; template: GmailTemplate } | ApiErr> {
  try {
    const res = await fetch("/api/gmail-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await res.json()) as { ok: true; template: GmailTemplate } | ApiErr;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function updateGmailTemplate(
  id: string,
  patch: Partial<{ name: string; stage: string; subject: string; body: string }> & {
    removeVariantId?: string;
  },
): Promise<{ ok: true; template: GmailTemplate } | ApiErr> {
  try {
    const res = await fetch(`/api/gmail-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return (await res.json()) as { ok: true; template: GmailTemplate } | ApiErr;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function deleteGmailTemplate(
  id: string,
): Promise<{ ok: true } | ApiErr> {
  try {
    const res = await fetch(`/api/gmail-templates/${id}`, { method: "DELETE" });
    return (await res.json()) as { ok: true } | ApiErr;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function generateSolaraVariant(
  id: string,
  guidance?: string,
): Promise<{ ok: true; template: GmailTemplate; variant: GmailTemplateVariant } | ApiErr> {
  try {
    const res = await fetch(`/api/gmail-templates/${id}/solara`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guidance: guidance || "" }),
    });
    return (await res.json()) as
      | { ok: true; template: GmailTemplate; variant: GmailTemplateVariant }
      | ApiErr;
  } catch {
    return { ok: false, error: "network" };
  }
}
