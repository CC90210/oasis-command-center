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
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { alertAudienceFor } from "@/lib/notify/alert-route";
import { shouldAlert } from "@/lib/notify/alert-decay";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { isRetiredTenant } from "@/lib/tenant/retired";

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
 * The form a failure names: the caller's slugs, else the form's own URL
 * (`/f/<tenant>/<form>/...`) that the submission carried, which is all a
 * signed-link submission has. Both are request input, so neither decides
 * anything until verifiedForm finds the form record they name.
 */
function namedForm(input: SubmitFailureInput): { tenantSlug: string; formSlug: string } | null {
  const tenantSlug = safeSlug(input.tenantSlug);
  const formSlug = safeSlug(input.formSlug);
  if (tenantSlug && formSlug) return { tenantSlug, formSlug };
  const p = input.payload && typeof input.payload === "object" ? (input.payload as Record<string, unknown>) : null;
  const path = typeof p?.submission_path === "string" ? p.submission_path : "";
  const parts = path.split("?")[0].split("/").filter(Boolean);
  if (parts[0] !== "f") return null;
  const t = safeSlug(parts[1]);
  const f = safeSlug(parts[2]);
  return t && f ? { tenantSlug: t, formSlug: f } : null;
}

type VerifiedForm = { tenantId: string; tenantSlug: string; formId: string; formSlug: string; formName: string };

/**
 * The form record the slugs name, through the same resolver the public form
 * page uses (an enabled form of that workspace), or null. The tenant id comes
 * from THE FORM RECORD, never from the slug a request sent.
 */
async function verifiedForm(named: { tenantSlug: string; formSlug: string } | null): Promise<VerifiedForm | null> {
  if (!named) return null;
  try {
    const found = await resolvePublicForm(
      getServiceSupabase() as unknown as Parameters<typeof resolvePublicForm>[0],
      named.tenantSlug,
      named.formSlug,
    );
    if (!found.ok) return null;
    return {
      tenantId: found.form.tenant_id,
      tenantSlug: found.tenant_slug,
      formId: found.form.id,
      formSlug: found.form.slug,
      formName: found.form.name,
    };
  } catch {
    return null;
  }
}

/**
 * The card's words. OASIS's own forms keep the operator detail CC recovers a
 * merchant from (the error line, crushed of identifiers, and the dead-letter
 * id). A client's card says what happened in plain words, with a reference
 * OASIS support can find the saved answers by: the client cannot open the
 * dead-letter store, and its error text is OASIS's internals.
 */
function failureCard(
  form: VerifiedForm,
  input: SubmitFailureInput,
  dead: { id: string; inserted: boolean },
  windowH: number,
): { title: string; body: string } {
  if (alertAudienceFor(form.tenantId) === "oasis_operator") {
    const errLine = redactForAlert(String(input.error).split("\n")[0].slice(0, 200));
    return {
      title: "Form submission blocked: a merchant could not submit",
      body:
        `${form.tenantSlug}/${form.formSlug} (step ${input.stepIndex ?? "?"}, ${input.source}). Error: ${errLine}. ` +
        (dead.inserted
          ? `Merchant data captured: dead-letter ${dead.id}; recover it and set recovered_at.`
          : "The dead-letter insert ALSO failed: only this alert records the loss.") +
        ` Re-alerts in ${windowH}h if it keeps happening; forms.submit_failures_open stays red until recovered.`,
    };
  }
  return {
    title: "Someone could not submit one of your forms",
    body:
      `A visitor's submission of "${form.formName}" did not go through. ` +
      (dead.inserted
        ? `Their answers were kept: contact OASIS support with reference ${dead.id} to get them.`
        : "Their answers could not be kept. Contact OASIS support if this keeps happening."),
  };
}

/**
 * Persist the dead-letter row, then tell THE WORKSPACE THAT OWNS THE FORM, on
 * the ONE decay ladder (lib/notify/alert-decay.ts, state in health_alert_state).
 *
 * WHOSE ALERT (2026-10-08). The workspace is the one the form record belongs
 * to, never a slug from the request. Its card goes in that workspace's own
 * Needs you list and its page to that workspace's own audience
 * (lib/notify/alert-route.ts): OASIS's chat for OASIS's own forms, a client's
 * own Telegram bot (or the card alone) for a client's. Until then the page went
 * to OASIS's lanes by slug, and an unmapped slug, which is every client's,
 * fanned the client's incident and error text to OASIS's chat and the retired
 * SunBiz chat. A failure that names no form we can find, or a retired
 * workspace's, pages nobody: the dead-letter row keeps it, and the estate
 * check forms.submit_failures_open counts it.
 *
 * The ladder key is COARSE — tenant/form/source, never the message — so a
 * burst of failing submissions pages once and escalates instead of storming.
 * Recovery (clearing the episode) belongs to the Fleet Health check, which
 * watches open rows and announces when they are closed; an event-shaped
 * failure path has no "recovered" moment of its own to observe.
 */
export async function captureSubmitFailure(input: SubmitFailureInput): Promise<{ id: string | null }> {
  const id = randomUUID();
  const named = namedForm(input);
  const tenantSlug = named?.tenantSlug ?? null;
  const formSlug = named?.formSlug ?? null;
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
    const form = await verifiedForm(named);
    if (!form || isRetiredTenant(form.tenantId)) {
      // No workspace to tell: the slugs name no form we can find (a forged
      // beacon, a deleted or disabled form, a signed link with no path), or
      // the form's workspace is retired. Nobody is paged; the dead-letter row
      // keeps the merchant's answers and the estate check counts it.
      console.warn("[submit-failure-capture] no workspace to alert; dead-letter only:", {
        id: inserted ? id : null,
        tenantSlug,
        formSlug,
        source: input.source,
      });
      return { id: inserted ? id : null };
    }
    const db = getServiceSupabase();
    const key = `submitfail:${form.tenantSlug}/${form.formSlug}/${input.source}`;
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
      // Persist the ladder state BEFORE the send: a crash mid-send costs one
      // page (the health check re-asserts within 15 min); the reverse ordering
      // storms on every crash-loop.
      await db.from("health_alert_state").upsert(
        {
          alert_key: key,
          tenant_id: form.tenantId,
          last_signature: key,
          last_alerted_at: new Date().toISOString(),
          repeat_n: decision.nextRepeatN,
          first_failed_at: state?.first_failed_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "alert_key" },
      );
    }
    // The card is written on every failure (a refresh while it is open), so
    // the workspace sees the latest one; the ladder decides whether it pages.
    await writeAgentAlert({
      tenantId: form.tenantId,
      alertType: "form_submit_blocked",
      severity: "urgent",
      subjectType: "form",
      subjectId: form.formId,
      ...failureCard(form, input, { id, inserted }, decision.windowH),
      payload: {
        form_slug: form.formSlug,
        source: input.source,
        step_index: Number.isFinite(input.stepIndex as number) ? input.stepIndex : null,
        dead_letter_id: inserted ? id : null,
      },
      telegram: decision.send,
    });
  } catch (err) {
    // The alert path must never take the request down with it. The open
    // dead-letter row keeps the health check red, so this failure is not
    // silent even here.
    console.error("[submit-failure-capture] alert path failed:", err);
  }

  return { id: inserted ? id : null };
}
