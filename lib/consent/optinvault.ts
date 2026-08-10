/**
 * lib/consent/optinvault.ts — browser-side consent capture against Opt-in Vault.
 *
 * WHY BROWSER-SIDE. The evidence is only worth having if it records the
 * MERCHANT'S source IP. A server-to-server call from our API would record our
 * Vercel IP, and the vault (correctly) trusts only what its own edge saw. So the
 * capture must originate in the visitor's browser.
 *
 * WHY NOT THEIR SCRIPT TAG. `optinvault.js` is a thin fetch wrapper. On our own
 * pages a typed module is better: no extra network hop, no CSP allowance, and
 * the failure path is ours to control. External sites we do not own still get
 * the script tag.
 *
 * THE RULE THAT MATTERS MOST: a rejected capture must never be recorded locally
 * as consent. If this fails we still accept the lead — refusing a merchant's
 * enquiry because our bookkeeping failed would be worse — but we record that we
 * have NO evidence, and nothing may later claim we do.
 */

/** A capture site must receive an identifier for EVERY channel it is configured
 *  for. SunBiz is email+sms, so email alone is rejected with 400; both are
 *  required. Verified against the live vault 2026-08-09. */
export type ConsentBrand = "sunbiz" | "bluerise";

export type ConsentCaptureResult =
  | {
      ok: true;
      consentId: string;
      certificateCode: string;
      payloadSha256: string;
      signatureHmac: string;
      disclosureVersion: string;
      retentionExpiresAt: string | null;
    }
  | { ok: false; reason: string; status: number | null };

type BrandConfig = {
  siteKey: string | undefined;
  disclosureVersion: string;
  /** Channels the site is registered for; every one needs an identifier. */
  requires: Array<"email" | "phone">;
};

function config(brand: ConsentBrand): BrandConfig {
  return brand === "bluerise"
    ? {
        siteKey: process.env.NEXT_PUBLIC_OPTINVAULT_SITE_KEY_BLUERISE,
        disclosureVersion: process.env.NEXT_PUBLIC_OPTINVAULT_DISCLOSURE_BLUERISE || "bluerise-v1-2026-08",
        requires: ["email"],
      }
    : {
        siteKey: process.env.NEXT_PUBLIC_OPTINVAULT_SITE_KEY_SUNBIZ,
        disclosureVersion: process.env.NEXT_PUBLIC_OPTINVAULT_DISCLOSURE_SUNBIZ || "sunbiz-v1-2026-08",
        requires: ["email", "phone"],
      };
}

/** Digits-only US input to E.164, which is what the vault requires. Returns null
 *  when it cannot be normalised, so we hold rather than send a malformed
 *  identifier that would be refused anyway. */
export function toE164(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 11 && String(raw).trim().startsWith("+")) return `+${digits}`;
  return null;
}

export type CaptureArgs = {
  brand: ConsentBrand;
  email?: string | null;
  phone?: string | null;
  /** Stable per submission so a retry of the SAME action does not create a
   *  second evidence record. */
  idempotencyKey: string;
  formUrl?: string;
};

/**
 * Seal a consent record. Never throws — the caller decides what to do with a
 * failure, and a form submission must not die because the vault is unreachable.
 */
export async function captureConsent(args: CaptureArgs): Promise<ConsentCaptureResult> {
  const base = process.env.NEXT_PUBLIC_OPTINVAULT_URL;
  const cfg = config(args.brand);
  if (!base || !cfg.siteKey) {
    return { ok: false, reason: "consent_vault_not_configured", status: null };
  }

  const email = typeof args.email === "string" && args.email.trim() ? args.email.trim().toLowerCase() : undefined;
  const phone = toE164(args.phone) ?? undefined;

  // Do not spend a request we know will be refused; report the real reason so
  // it shows up as missing evidence rather than a vague network failure.
  const missing = cfg.requires.filter((c) => (c === "email" ? !email : !phone));
  if (missing.length > 0) {
    return { ok: false, reason: `missing_identifier:${missing.join(",")}`, status: null };
  }

  const body: Record<string, unknown> = {
    disclosure_version: cfg.disclosureVersion,
    affirmative_action: "form_submit",
    form_url: args.formUrl || (typeof window !== "undefined" ? window.location.href : ""),
  };
  if (email) body.email = email;
  if (phone) body.phone = phone;

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/consent/log`, {
      method: "POST",
      // The vault refuses redirects and wants no credentials; matching that here
      // keeps a misconfiguration loud instead of silently following somewhere.
      redirect: "error",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "X-OptInVault-Site-Key": cfg.siteKey,
        "Idempotency-Key": args.idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return { ok: false, reason: String(json?.error ?? `http_${res.status}`), status: res.status };
    }
    return {
      ok: true,
      consentId: String(json?.consent_id ?? ""),
      certificateCode: String(json?.certificate_code ?? ""),
      payloadSha256: String(json?.payload_sha256 ?? ""),
      signatureHmac: String(json?.signature_hmac ?? ""),
      disclosureVersion: cfg.disclosureVersion,
      retentionExpiresAt: json?.retention_expires_at ? String(json.retention_expires_at) : null,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 120) : "network_error", status: null };
  }
}
