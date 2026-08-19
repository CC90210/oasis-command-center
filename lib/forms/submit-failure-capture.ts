/**
 * lib/forms/submit-failure-capture.ts — dead-letter + immediate page for a
 * public form submission that could not complete.
 *
 * WHY. The or() parser crash (#224) destroyed every dotted-local-email
 * submission PRE-insert for nine days: merchants saw an error banner, nothing
 * was stored, no alert fired, and the applications were unrecoverable because
 * the failure path kept no copy. Adon's mandate (2026-08-18): the second one
 * application is blocked, page immediately — and never lose the merchant again.
 *
 * Two callers, one seam:
 *   - /api/forms/submit top-level catch  (source: "server_catch")
 *   - /api/forms/submit-failure beacon   (source: "client_beacon" — failures
 *     our server never saw: platform 413s, Vercel error pages, network death)
 *
 * Contract: NEVER throws, and the alert is not conditional on the dead-letter
 * insert succeeding — a broken table must not also silence the page. The
 * Fleet Health check forms.submit_failures_open re-asserts on the 15-min cron
 * while any open row exists, and announces recovery when rows are closed.
 */

import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram } from "@/lib/notify/telegram";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { shouldAlert } from "@/lib/notify/alert-decay";

/** Slugs reach the alert text and the DB; merchants type neither, but the
 *  beacon is public input — allowlist rather than trust. */
const SLUG_RE = /^[\w-]{1,80}$/;

/** Keep a recovery record, not a document store: inline file bytes are
 *  replaced with their metadata, and the whole snapshot is capped. */
const PAYLOAD_CAP_BYTES = 100_000;

export type SubmitFailureInput = {
  source: "server_catch" | "client_beacon";
  tenantSlug?: string | null;
  formSlug?: string | null;
  stepIndex?: number | null;
  error: string;
  errorStack?: string | null;
  /** The submission body as far as the caller has it. Stored after
   *  stripFiles(); this is what makes the merchant recoverable. */
  payload?: unknown;
  userAgent?: string | null;
};

/** Replace inline file bytes with metadata so the snapshot stays small and the
 *  dead-letter table never becomes a shadow document store. */
export function stripFiles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFiles);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.inline_base64 === "string") {
      return {
        stripped_file: true,
        filename: obj.filename ?? null,
        mime_type: obj.mime_type ?? null,
        size_bytes: obj.size_bytes ?? null,
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = stripFiles(v);
    return out;
  }
  return value;
}

/** The alert goes to Telegram; the error text can embed merchant identifiers
 *  (the or() crash message carried an email fragment). Crush email- and
 *  phone-shaped substrings for the ALERT only — the DB row keeps the full text. */
export function redactForAlert(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/(?<!\d)\+?\d[\d\s().-]{8,}\d(?!\d)/g, "<number>");
}

function safeSlug(v: unknown): string | null {
  return typeof v === "string" && SLUG_RE.test(v) ? v : null;
}

export function cappedJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const s = JSON.stringify(stripFiles(value));
    if (s.length <= PAYLOAD_CAP_BYTES) return s;
    // The column must stay parseable JSON for recovery tooling, and a raw
    // slice of serialized JSON cuts mid-token on exactly the largest
    // submissions (Codex P2, 2026-08-18). Wrap the head as an escaped STRING —
    // valid JSON at any cut point, contact fields live near the front.
    return JSON.stringify({ truncated: true, head: s.slice(0, PAYLOAD_CAP_BYTES) });
  } catch {
    return null;
  }
}

/**
 * Persist the dead-letter row and page the sunbiz-ops lane on the ONE decay
 * ladder (lib/notify/alert-decay.ts, state in health_alert_state).
 *
 * The ladder key is COARSE — tenant/form/source, never the message — so a
 * burst of failing submissions pages once and escalates instead of storming.
 * Recovery (clearing the episode) belongs to the Fleet Health check, which
 * watches open rows and announces when they are closed; an event-shaped
 * failure path has no "recovered" moment of its own to observe.
 */
export async function captureSubmitFailure(input: SubmitFailureInput): Promise<{ id: string | null }> {
  const id = randomUUID();
  const tenantSlug = safeSlug(input.tenantSlug);
  const formSlug = safeSlug(input.formSlug);
  let inserted = false;

  try {
    const db = getServiceSupabase();
    const r = await db.from("form_submit_failures").insert({
      id,
      source: input.source,
      tenant_slug: tenantSlug,
      form_slug: formSlug,
      step_index: Number.isFinite(input.stepIndex as number) ? input.stepIndex : null,
      error_message: String(input.error).slice(0, 1000),
      error_stack: input.errorStack ? String(input.errorStack).slice(0, 4000) : null,
      payload: cappedJson(input.payload),
      user_agent: input.userAgent ? String(input.userAgent).slice(0, 300) : null,
      created_at: new Date().toISOString(),
    });
    inserted = !r.error;
  } catch {
    inserted = false;
  }

  try {
    const db = getServiceSupabase();
    const key = `submitfail:${tenantSlug ?? "unknown"}/${formSlug ?? "unknown"}/${input.source}`;
    const stateRow = await db
      .from("health_alert_state")
      .select("*")
      .eq("alert_key", key)
      .maybeSingle();
    const state = stateRow.data as
      | { last_signature: string | null; last_alerted_at: string | null; repeat_n: number | null; first_failed_at: string | null }
      | null;
    const decision = shouldAlert(key, {
      lastSignature: state?.last_signature,
      lastAlertedAt: state?.last_alerted_at,
      repeatN: state?.repeat_n,
    });
    if (decision.send) {
      const errLine = redactForAlert(String(input.error).split("\n")[0].slice(0, 200));
      const text =
        `🔴 <b>FORM SUBMISSION BLOCKED</b> — a merchant could not submit\n` +
        `form: <b>${escapeTelegramHtml(`${tenantSlug ?? "?"}/${formSlug ?? "?"}`)}</b> (step ${input.stepIndex ?? "?"}, ${input.source})\n` +
        `error: ${escapeTelegramHtml(errLine)}\n` +
        (inserted
          ? `merchant data captured — dead-letter <code>${escapeTelegramHtml(id)}</code>; recover + set recovered_at`
          : `⚠️ dead-letter insert ALSO failed — only this alert records the loss`) +
        `\n<i>re-alerts in ${decision.windowH}h if it keeps happening; forms.submit_failures_open stays red until recovered</i>`;
      // Persist the ladder state BEFORE the send: a crash mid-send costs one
      // page (the health check re-asserts within 15 min); the reverse ordering
      // storms on every crash-loop.
      await db.from("health_alert_state").upsert(
        {
          alert_key: key,
          last_signature: key,
          last_alerted_at: new Date().toISOString(),
          repeat_n: decision.nextRepeatN,
          first_failed_at: state?.first_failed_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "alert_key" },
      );
      await sendTelegram(text, { lane: "sunbiz-ops" }).catch(() => undefined);
    }
  } catch (err) {
    // The alert path must never take the request down with it. The open
    // dead-letter row keeps the health check red, so this failure is not
    // silent even here.
    console.error("[submit-failure-capture] alert path failed:", err);
  }

  return { id: inserted ? id : null };
}
