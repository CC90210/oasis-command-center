/**
 * Server-side validation for Gmail (plain-text) template writes.
 *
 * Every write path (create, update, Solara variant) funnels through
 * `validateGmailTemplateFields` so the format constraint (no HTML), the
 * compliance denylist (broker-positioning phrases — SunBiz positions as a
 * direct lender), and the no-em-dash rule hold uniformly. Fail-closed: any
 * violation rejects the write with the offending hits, nothing is stored.
 */

import { stripDashes, matchPositioningPhrases } from "@/lib/integrations/blast-safety-core";
import {
  containsHtml,
  GMAIL_BODY_MAX,
  GMAIL_NAME_MAX,
  GMAIL_SUBJECT_MAX,
  GMAIL_TEMPLATE_STAGE_KEYS,
} from "@/lib/gmail-templates";

export type GmailFieldInput = {
  name?: unknown;
  stage?: unknown;
  subject?: unknown;
  body?: unknown;
};

export type GmailFieldResult =
  | { ok: true; fields: { name?: string; stage?: string; subject?: string; body?: string } }
  | { ok: false; error: string; message?: string; hits?: string[] };

/**
 * Validate + normalize template fields. In `partial` mode (PATCH) absent
 * fields pass through; in full mode (POST) name/stage/body are required.
 */
export function validateGmailTemplateFields(
  input: GmailFieldInput,
  opts: { partial: boolean },
): GmailFieldResult {
  const fields: { name?: string; stage?: string; subject?: string; body?: string } = {};

  if (input.name !== undefined || !opts.partial) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { ok: false, error: "name_required" };
    }
    if (input.name.trim().length > GMAIL_NAME_MAX) {
      return { ok: false, error: "name_too_long" };
    }
    fields.name = stripDashes(input.name.trim());
  }

  if (input.stage !== undefined || !opts.partial) {
    if (typeof input.stage !== "string" || !GMAIL_TEMPLATE_STAGE_KEYS.has(input.stage)) {
      return { ok: false, error: "unknown_stage" };
    }
    fields.stage = input.stage;
  }

  if (input.subject !== undefined) {
    if (typeof input.subject !== "string") {
      return { ok: false, error: "invalid_subject" };
    }
    const subject = stripDashes(input.subject.trim());
    if (subject.length > GMAIL_SUBJECT_MAX) {
      return { ok: false, error: "subject_too_long" };
    }
    if (containsHtml(subject)) {
      return {
        ok: false,
        error: "html_not_allowed",
        message: "Gmail templates are plain text — remove HTML from the subject.",
      };
    }
    fields.subject = subject;
  }

  if (input.body !== undefined || !opts.partial) {
    if (typeof input.body !== "string" || !input.body.trim()) {
      return { ok: false, error: "body_required" };
    }
    // Normalize CRLF so stored bodies are consistent across OS/paste sources.
    const body = stripDashes(input.body.replace(/\r\n/g, "\n").trim());
    if (body.length > GMAIL_BODY_MAX) {
      return { ok: false, error: "body_too_long" };
    }
    if (containsHtml(body)) {
      return {
        ok: false,
        error: "html_not_allowed",
        message: "Gmail templates are plain text — paste the text version, not HTML.",
      };
    }
    fields.body = body;
  }

  // Compliance denylist over everything user-visible in the email.
  const emailText = [fields.subject ?? "", fields.body ?? ""].join("\n");
  if (emailText.trim()) {
    const hits = matchPositioningPhrases(emailText);
    if (hits.length) {
      return {
        ok: false,
        error: "positioning_blocked",
        message:
          "Copy positions SunBiz as a broker — SunBiz is presented as a direct funder. Rework the flagged phrases.",
        hits,
      };
    }
  }

  return { ok: true, fields };
}
