"use client";

/**
 * FormPublicClient — multi-step interactive funnel for the public form
 * page (/f/<tenant>/<form_slug>/<lead_token>).
 *
 * Phase 3.4 of the SunBiz CRM build. Owns the prospect-side state:
 * current step, field values per step, submit loading, view-tracking
 * fire-once-on-mount, and post-submit thank-you screen.
 *
 * Re-uses FormRenderer so the operator preview and the prospect render
 * are pixel-identical.
 *
 * File uploads: small files (< 5 MB) get inline base64-encoded into
 * payload._files[]. Larger files are out of scope for v1 — we surface
 * a "file too large" error and the operator follows up by email. Phase
 * 6 (lender shop-out) will add Supabase Storage handoff when the
 * bank-statement step gets first-class treatment.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { FormRenderer } from "./FormRenderer";
import type { FormStep, FormBranding } from "@/lib/forms/types";
import { isFieldVisible } from "@/lib/forms/visibility";
import { DEFAULT_PRIMARY_COLOR, getContrastingTextColor } from "@/lib/forms/themes";

// Submit-side route (api/forms/submit) now decodes the base64 and uploads
// to Supabase Storage instead of holding the bytes in form_submissions.
// 15 MB matches Vercel's request body limit minus base64 overhead (~1.33×)
// — bigger than that fails on the platform, not in our code.
const INLINE_FILE_MAX_BYTES = 15 * 1024 * 1024;

type Props = {
  formId: string;
  formName: string;
  branding: FormBranding;
  steps: FormStep[];
  redirectUrl: string | null;
  /**
   * Pre-signed HMAC token tied to a specific lead — used by Solara's
   * personalized mint flow. Null for the anonymous-share flow, in which
   * case `anonymousInit` MUST be set and the server will mint a fresh
   * token + lead on the first submit.
   */
  token: string | null;
  // rep flows straight into submitBody.anonymous_init (per-agent routing).
  anonymousInit?: { tenant_slug: string; form_slug: string; rep?: string };
  /**
   * Cross-form pre-fill (2026-06-20 — Ethan/Alex). When the form is opened from
   * a personalized lead link, the server loads the lead's existing data (name,
   * phone, email, monthly_revenue, business_name, …) and passes it here. Fields
   * are seeded from this map — by `prefill_from` (lead key) or by matching field
   * name — so a merchant never re-types what they already gave on the first form.
   * Every seeded value stays editable.
   */
  prefill?: Record<string, unknown> | null;
};

type SubmitResponse = {
  ok: boolean;
  submission_id?: string;
  next_step?: number | null;
  lead_stage?: string | null;
  redirect_url?: string | null;
  error?: string;
  /** Set on the first anonymous-flow submit so subsequent steps re-use it. */
  minted_token?: string | null;
  /** Personalized "continue now" links — present on the interest form's
   *  completion only; the thank-you screen renders them as buttons. */
  next_forms?: Array<{ slug: string; label: string; url: string }> | null;
};

export function FormPublicClient({
  formName,
  branding,
  steps,
  redirectUrl,
  token: initialToken,
  anonymousInit,
  prefill,
}: Props) {
  // The token starts as whatever the page passed in. For anonymous flows
  // it's null; the first /api/forms/submit response carries minted_token,
  // which we capture and use for the rest of the steps.
  const [token, setToken] = useState<string | null>(initialToken);
  // Per-step values keyed by step index so going back doesn't lose data.
  const [stepValues, setStepValues] = useState<Record<number, Record<string, unknown>>>(
    () =>
      Object.fromEntries(
        steps.map((step, idx) => [
          idx,
          // Seed hidden fields with their static value so submit handlers
          // don't have to special-case them.
          Object.fromEntries(
            step.fields
              .filter((f) => f.type === "hidden" && f.value !== undefined)
              .map((f) => [f.name, f.value]),
          ),
        ]),
      ),
  );
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Personalized links to the next forms (interest-form completion only),
  // rendered as "continue now" buttons on the thank-you screen.
  const [nextForms, setNextForms] = useState<
    Array<{ slug: string; label: string; url: string }>
  >([]);

  // Fire view-ping exactly once on mount. Anonymous flows can't ping
  // /api/forms/view yet — there's no lead until the first submit — so
  // we skip the ping when the token is null and let the submission row
  // be the first signal the operator sees.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) return;
    if (!token) return;
    viewedRef.current = true;
    fetch("/api/forms/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {
      // Best-effort — view tracking failure shouldn't disrupt the form UX.
    });
  }, [token]);

  const step = steps[currentStep];

  // Memoise so `values` is stable across renders when stepValues[currentStep]
  // hasn't changed — keeps the validate() useCallback below from re-creating
  // every render and re-triggering downstream effects.
  const values = useMemo(
    () => stepValues[currentStep] || {},
    [stepValues, currentStep],
  );

  // Flattened map of every answered field across all steps. Field names are
  // unique form-wide, so a plain assign is lossless. The renderer + validators
  // evaluate `show_if` against this so a step-1 field can react to a step-0
  // selection (the CC funnel: interest picked on step 0 → branch on step 1).
  const mergedValues = useMemo(
    () => Object.assign({}, ...Object.values(stepValues)),
    [stepValues],
  );

  const setFieldValue = useCallback(
    (name: string, value: unknown) => {
      setStepValues((prev) => ({
        ...prev,
        [currentStep]: { ...(prev[currentStep] || {}), [name]: value },
      }));
      setErrors((prev) => {
        if (!prev[name]) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
    },
    [currentStep],
  );

  // Pre-fill: when a step is shown, seed each empty field. Two sources, in order:
  //   1. prefill_from — another field already answered IN THIS submission
  //      (Fix 1.1: signature_name ← owner_full_name) OR a lead key from the
  //      server `prefill` map (2026-06-20: owner_full_name ← contact_name, etc.).
  //   2. direct name match in the server `prefill` map (e.g. email/phone the
  //      lead already gave on the intake form).
  // Every seeded value stays editable (we only fill when the field is empty).
  useEffect(() => {
    const cur = stepValues[currentStep] || {};
    const seedable = (v: unknown): v is string | number =>
      (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && isFinite(v));
    for (const f of step.fields) {
      const existing = cur[f.name];
      if (existing !== undefined && existing !== null && existing !== "") continue;
      // 1. prefill_from: same-submission answer first, then the lead prefill map.
      if (f.prefill_from) {
        const src = mergedValues[f.prefill_from] ?? prefill?.[f.prefill_from];
        if (seedable(src)) {
          setFieldValue(f.name, src);
          continue;
        }
      }
      // 2. direct field-name match in the lead prefill map.
      const direct = prefill?.[f.name];
      if (seedable(direct)) {
        setFieldValue(f.name, direct);
      }
    }
    // Seed only on step entry — mergedValues is current at that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  const validate = useCallback((): boolean => {
    const next: Partial<Record<string, string>> = {};
    for (const field of step.fields) {
      if (!field.required) continue;
      // A field hidden by show_if is never required (matches the renderer + the
      // server-side validator). An AI-only lead isn't blocked by Music fields.
      if (!isFieldVisible(field, mergedValues)) continue;
      const v = values[field.name];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
        next[field.name] = "Required";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [step.fields, values, mergedValues]);

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          // strip the data:...;base64, prefix
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        } else {
          reject(new Error("expected string result"));
        }
      };
      reader.onerror = () => reject(reader.error || new Error("file read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function buildSubmitPayload(): Promise<{
    payload: Record<string, unknown>;
    file_attachments: Array<{
      field_name: string;
      storage_path: string;
      mime_type: string;
      size_bytes: number;
    }>;
  } | { error: string }> {
    const payload: Record<string, unknown> = {};
    const file_attachments: Array<{
      field_name: string;
      storage_path: string;
      mime_type: string;
      size_bytes: number;
    }> = [];

    for (const field of step.fields) {
      // Drop fields hidden by show_if so an abandoned branch (pick AI, fill it,
      // then de-select AI) never ships stale answers that the lead record or
      // the AI welcome email would otherwise reference.
      if (!isFieldVisible(field, mergedValues)) continue;
      const v = values[field.name];
      if (field.type === "file_upload" && v instanceof File) {
        if (v.size > INLINE_FILE_MAX_BYTES) {
          return {
            error: `File "${v.name}" is ${(v.size / (1024 * 1024)).toFixed(1)} MB — files larger than ${INLINE_FILE_MAX_BYTES / (1024 * 1024)} MB aren't supported on this form yet. Email it to your contact instead.`,
          };
        }
        const base64 = await fileToBase64(v);
        // For v1 we inline the base64 into the payload alongside the
        // attachment metadata; the operator can pull it back from
        // form_submissions.payload. Phase 6 (lender shop-out) replaces
        // this with Supabase Storage handoff for proper bank-statement
        // workflows.
        payload[field.name] = {
          inline_base64: base64,
          filename: v.name,
          mime_type: v.type || "application/octet-stream",
          size_bytes: v.size,
        };
        file_attachments.push({
          field_name: field.name,
          storage_path: `inline:${field.name}`,
          mime_type: v.type || "application/octet-stream",
          size_bytes: v.size,
        });
      } else if (v !== undefined && v !== null && v !== "") {
        payload[field.name] = v;
      }
    }

    return { payload, file_attachments };
  }

  async function submit() {
    if (!validate()) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const built = await buildSubmitPayload();
      if ("error" in built) {
        setServerError(built.error);
        return;
      }
      // Anonymous flow: on step 0 we have no token yet, send
      // anonymous_init so the server mints + returns one. Personalized
      // flow: always send the existing token.
      const submitBody: Record<string, unknown> = {
        step_index: currentStep,
        payload: built.payload,
        file_attachments: built.file_attachments,
      };
      if (token) {
        submitBody.token = token;
      } else if (anonymousInit) {
        submitBody.anonymous_init = anonymousInit;
      }
      const res = await fetch("/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitBody),
      });
      const data = (await res.json()) as SubmitResponse;
      if (!data.ok) {
        setServerError(
          data.error === "rate_limited"
            ? "Too many submissions too fast. Wait a few seconds and try again."
            : data.error || `Submission failed (http_${res.status}).`,
        );
        return;
      }
      // Capture the freshly-signed token from an anonymous step 0 so
      // step 1+ uses it like any other personalized submit.
      if (!token && data.minted_token) {
        setToken(data.minted_token);
      }

      // Next-step navigation OR final-step completion.
      if (data.next_step !== null && data.next_step !== undefined) {
        setCurrentStep(data.next_step);
      } else {
        // Final step done. Capture any continue-now links the server returned
        // (interest form only) so the thank-you screen can offer them.
        setNextForms(data.next_forms ?? []);
        const target = data.redirect_url || redirectUrl;
        if (target) {
          window.location.href = target;
        } else {
          setDone(true);
        }
      }
    } catch (err) {
      setServerError(
        err instanceof Error ? `Network error: ${err.message}` : "Network error.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const primary = branding.primary_color || DEFAULT_PRIMARY_COLOR;
  const headline = branding.headline || formName;
  const thanksMessage =
    branding.thanks_message ||
    "Thanks — your details are in. A specialist will reach out within one business day.";

  return (
    <main className="min-h-screen bg-bg-deep text-fg flex items-start sm:items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl space-y-6">
        {/* Brand header — logo if the tenant set one, otherwise a clean
            branded sun mark so the form reads as the brand (not the
            internal form name). */}
        <header className="text-center space-y-3">
          {branding.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logo_url} alt={headline} className="mx-auto h-12" />
          ) : (
            <div
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ background: `${primary}1f`, border: `1px solid ${primary}55` }}
            >
              <SunMark color={primary} />
            </div>
          )}
          <div className="space-y-2">
            <h1 className="text-2xl font-black tracking-tight text-fg">{headline}</h1>
            <div
              className="mx-auto h-0.5 w-12 rounded-full"
              style={{ background: primary }}
            />
          </div>
          {branding.subheadline && (
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-fg-muted">
              {branding.subheadline}
            </p>
          )}
        </header>

        {/* Step indicator */}
        {steps.length > 1 && (
          <div className="flex items-center justify-center gap-1.5">
            {steps.map((_, idx) => (
              <div
                key={idx}
                className="w-2 h-2 rounded-full transition-colors"
                style={{
                  backgroundColor:
                    idx < currentStep
                      ? primary
                      : idx === currentStep
                        ? primary
                        : "#3a3a40",
                  opacity: idx === currentStep ? 1 : idx < currentStep ? 0.6 : 0.3,
                }}
              />
            ))}
            <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-dim">
              Step {currentStep + 1} / {steps.length}
            </span>
          </div>
        )}

        {/* Body */}
        <div className="rounded-2xl border border-bg-border bg-bg-elev/40 p-6 shadow-lg">
          {done ? (
            <div className="text-center space-y-4 py-8">
              <CheckCircle2
                className="w-12 h-12 mx-auto"
                style={{ color: primary }}
              />
              <h2 className="text-xl font-bold text-fg">All set.</h2>
              <p className="text-sm text-fg-muted max-w-md mx-auto">
                {thanksMessage}
              </p>
              {nextForms.length > 0 && (
                <div className="pt-3 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-fg-dim">
                    Have a few minutes? Keep going
                  </div>
                  <div className="mx-auto flex max-w-sm flex-col gap-2">
                    {nextForms.map((f) => (
                      <a
                        key={f.slug}
                        href={f.url}
                        className="flex min-h-[44px] w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-bold shadow-sm transition-opacity hover:opacity-90"
                        style={{ backgroundColor: primary, color: getContrastingTextColor(primary) }}
                      >
                        {f.label} →
                      </a>
                    ))}
                  </div>
                  <p className="text-[11px] text-fg-dim">
                    No rush — we&apos;ve emailed these links too, so you can finish anytime.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
              {serverError && (
                <div className="mb-4 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{serverError}</span>
                </div>
              )}
              <FormRenderer
                step={step}
                values={mergedValues}
                errors={errors}
                branding={branding}
                onFieldChange={setFieldValue}
                onSubmit={submit}
                submitting={submitting}
                showBack={currentStep > 0}
                onBack={() => setCurrentStep((i) => Math.max(0, i - 1))}
                ctaLabelOverride={
                  currentStep === steps.length - 1 ? step.cta_label || "Submit" : undefined
                }
                uploadToken={token}
              />
            </>
          )}
        </div>

        {/* Footer note — light, brand-neutral reassurance. Tenant-agnostic copy:
            this renders on every tenant's public form (SunBiz funding + CC's
            personal-brand funnel), so it must not be funding-specific. */}
        <p className="text-center text-[11px] text-fg-dim">
          Your information is kept private — only used to follow up on your request.
        </p>

        {/* Hardcoded "Powered by OASIS AI" footer removed 2026-05-25
            (CC cross-tenant audit). A Sun Biz lead filling out a Sun
            Biz application form shouldn't see OASIS AI attribution
            on the public-facing page. If a tenant wants attribution
            they can render it via branding.subheadline or extend
            FormBranding with a footer_label field. */}
      </div>
    </main>
  );
}

/** Gold SunBiz sun glyph — rendered in the form header when the tenant
 *  hasn't uploaded a logo, so the form still reads as the brand. */
function SunMark({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" fill={color} stroke="none" />
      <line x1="12" y1="2.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21.5" y2="12" />
      <line x1="5.4" y1="5.4" x2="7" y2="7" />
      <line x1="17" y1="17" x2="18.6" y2="18.6" />
      <line x1="5.4" y1="18.6" x2="7" y2="17" />
      <line x1="17" y1="7" x2="18.6" y2="5.4" />
    </svg>
  );
}
