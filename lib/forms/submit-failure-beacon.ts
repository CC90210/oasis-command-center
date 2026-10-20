/**
 * The failure beacon a public form's page sends when a submission dies.
 *
 * A submit that dies at the platform edge (413, error page, network) never
 * reaches our server code, and a fault the route answers (server_error,
 * form_unavailable, ...) leaves the visitor gone if they give up. Without this
 * the merchant's loss is invisible AND unrecoverable: /api/forms/submit-failure
 * keeps a dead-letter copy of the answers and pages the form's workspace
 * (lib/forms/submit-failure-capture.ts).
 *
 * One copy for every page that posts to /api/forms/submit: the public form
 * (FormPublicClient), /book (BookingPage) and the homepage audit (AuditForm).
 * The last two used to send none (independent review of #714).
 *
 * Sends the answers minus file bytes: contact fields are what recovery needs,
 * and file bytes are what made the request too big. That means a File in the
 * on-screen answers AND the base64 a built payload carries: a keepalive request
 * over 64 KiB is refused by the browser, so one attached file used to lose the
 * whole beacon. Fire and forget: it never throws and never adds a second
 * failure on top of the first.
 */

/** The route's answers that mean a fault the visitor cannot fix, worth a beacon. */
export const BEACON_ERRORS: ReadonlySet<string> = new Set([
  "server_error",
  "form_unavailable",
  "upload_unavailable",
  "consent_record_unavailable",
]);

/**
 * Whether a refused submit was our fault, not the visitor's: no JSON answer
 * (a platform error page, a 413), any 5xx, or one of BEACON_ERRORS. One rule
 * for every page that posts to /api/forms/submit, each of which answers such a
 * failure with "please try again" and a beacon. A 4xx the route explains is
 * the form working. Counting only BEACON_ERRORS, /book told a visitor whose
 * details were saved to "check them", and paged nobody, for every 5xx the list
 * did not name (independent review of #714, round 3).
 */
export function isSubmitFault(status: number, data: { error?: string } | null): boolean {
  return !data || status >= 500 || (data.error !== undefined && BEACON_ERRORS.has(data.error));
}

export function sendSubmitFailureBeacon(input: {
  tenantSlug?: string | null;
  formSlug?: string | null;
  stepIndex: number;
  error: string;
  payload: Record<string, unknown>;
  /** A router's answer, which stored nothing: its row is filed already recovered. */
  nothingToRecover?: boolean;
  /**
   * The consent boxes the failed step showed, and whether each was ticked. A
   * decline the route could not record (consent_record_unavailable) leaves an
   * earlier tick standing: whoever follows up must know, or they market to
   * someone who just said no (independent review of #714, round 3).
   */
  consentLedger?: { email?: boolean; sms?: boolean } | null;
}): void {
  try {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.payload)) {
      if (typeof File !== "undefined" && v instanceof File) {
        safe[k] = { skipped_file: v.name, size_bytes: v.size };
      } else if (v && typeof v === "object" && typeof (v as { inline_base64?: unknown }).inline_base64 === "string") {
        const f = v as { filename?: unknown; size_bytes?: unknown };
        safe[k] = { skipped_file: f.filename ?? null, size_bytes: f.size_bytes ?? null };
      } else {
        safe[k] = v;
      }
    }
    void fetch("/api/forms/submit-failure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant_slug: input.tenantSlug ?? undefined,
        form_slug: input.formSlug ?? undefined,
        step_index: input.stepIndex,
        error: input.error.slice(0, 400),
        payload: safe,
        ...(input.nothingToRecover ? { nothing_to_recover: true } : {}),
        ...(input.consentLedger ? { consent_ledger: input.consentLedger } : {}),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // The beacon must never add a second failure on top of the first.
  }
}
