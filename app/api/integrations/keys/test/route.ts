/**
 * POST /api/integrations/keys/test — runtime probe for a stored
 * integration. Body: { service: "twilio" | "stripe" | ... }.
 *
 * Each handler pings the provider with a lightweight request that
 * exercises the credential without producing a side effect (no
 * outbound SMS, no email, no Stripe charge). Test results are
 * persisted on the credential rows so the settings panel can render
 * "Verified · 5m ago" vs "Failed · invalid token".
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  getTenantIntegrationBundle,
  recordIntegrationTest,
  findIntegrationSchema,
} from "@/lib/tenant-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let body: { service?: unknown };
  try {
    body = (await req.json()) as { service?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const service = typeof body.service === "string" ? body.service.toLowerCase() : "";
  const schema = findIntegrationSchema(service);
  if (!schema) {
    return NextResponse.json({ ok: false, error: "unknown_service" }, { status: 400 });
  }

  const bundle = await getTenantIntegrationBundle(sess.tenantId, service);
  let result: { ok: boolean; error?: string; detail?: string };
  try {
    result = await runProbe(service, bundle);
  } catch (err) {
    result = { ok: false, error: (err as Error).message || "probe_threw" };
  }

  // Persist test status on every field the schema declares so the
  // settings UI can render the per-field verified indicator.
  await Promise.all(
    schema.fields.map((f) =>
      recordIntegrationTest({
        tenantId: sess.tenantId,
        service,
        fieldKey: f.key,
        ok: result.ok,
        error: result.error,
      }),
    ),
  );

  return NextResponse.json({
    ok: result.ok,
    service,
    error: result.ok ? null : result.error || "unknown_error",
    detail: result.detail || null,
  });
}

async function runProbe(
  service: string,
  bundle: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  switch (service) {
    case "twilio":
      return probeTwilio(bundle);
    case "stripe":
      return probeStripe(bundle);
    case "telegram":
      return probeTelegram(bundle);
    case "n8n":
      return probeN8n(bundle);
    case "texttorrent":
    case "gws":
    case "smtp":
    case "late":
      // Side-effect-free verifications for these aren't trivial:
      //   - TextTorrent: no public "account" endpoint
      //   - GWS: App Password verification = attempt SMTP STARTTLS
      //   - SMTP: same
      //   - Late: no read endpoint
      // For now, "presence" is the test — every required field set
      // counts as a pass; the real verification is the first real
      // send. Better than a fake test that always returns ok.
      return probePresence(service, bundle);
    default:
      return { ok: false, error: `no_probe_for_${service}` };
  }
}

async function probePresence(
  service: string,
  bundle: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const schema = findIntegrationSchema(service);
  if (!schema) return { ok: false, error: "unknown_service" };
  const missing = schema.fields
    .filter((f) => !f.label.toLowerCase().includes("(optional)"))
    .filter((f) => !bundle[f.key])
    .map((f) => f.key);
  if (missing.length > 0) {
    return { ok: false, error: `missing_fields: ${missing.join(", ")}` };
  }
  return { ok: true, detail: "all required fields present (no live probe available)" };
}

async function probeTwilio(
  bundle: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const sid = bundle.account_sid;
  const token = bundle.auth_token;
  if (!sid || !token) {
    return { ok: false, error: "missing_sid_or_token" };
  }
  // Account-info GET — costs nothing, no side effect, returns 401 on
  // bad creds and 200 on good. Auth = Basic(sid:token).
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`;
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        Accept: "application/json",
      },
    });
    if (r.status === 200) {
      const j = (await r.json().catch(() => ({}))) as { friendly_name?: string; status?: string };
      return {
        ok: true,
        detail: `Twilio account "${j.friendly_name || sid}" — ${j.status || "active"}`,
      };
    }
    if (r.status === 401) return { ok: false, error: "invalid_credentials" };
    return { ok: false, error: `twilio_http_${r.status}` };
  } catch (err) {
    return { ok: false, error: `network_error: ${(err as Error).message}` };
  }
}

async function probeStripe(
  bundle: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const key = bundle.secret_key;
  if (!key) return { ok: false, error: "missing_secret_key" };
  // /v1/account is the canonical "is my key live" probe. Free,
  // read-only, no side effects.
  try {
    const r = await fetch("https://api.stripe.com/v1/account", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
    if (r.status === 200) {
      const j = (await r.json().catch(() => ({}))) as { id?: string; business_profile?: { name?: string } };
      return {
        ok: true,
        detail: `Stripe account ${j.id || ""} — ${j.business_profile?.name || "unnamed"}`,
      };
    }
    if (r.status === 401) return { ok: false, error: "invalid_secret_key" };
    return { ok: false, error: `stripe_http_${r.status}` };
  } catch (err) {
    return { ok: false, error: `network_error: ${(err as Error).message}` };
  }
}

async function probeTelegram(
  bundle: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const token = bundle.bot_token;
  if (!token) return { ok: false, error: "missing_bot_token" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
    });
    if (r.status !== 200) {
      return { ok: false, error: `telegram_http_${r.status}` };
    }
    const j = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { username?: string; first_name?: string };
    };
    if (!j.ok) return { ok: false, error: "telegram_returned_not_ok" };
    return {
      ok: true,
      detail: `@${j.result?.username || j.result?.first_name || "bot"}`,
    };
  } catch (err) {
    return { ok: false, error: `network_error: ${(err as Error).message}` };
  }
}

async function probeN8n(
  bundle: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const url = bundle.outbound_url;
  if (!url) return { ok: false, error: "missing_outbound_url" };
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, error: "outbound_url_protocol" };
    }
    // HEAD request — n8n's webhook endpoints respond to HEAD with 200
    // or 405 depending on workflow. Either is "endpoint exists";
    // network failure / DNS failure means misconfigured.
    const r = await fetch(url, { method: "HEAD" });
    if (r.status >= 200 && r.status < 500) {
      return { ok: true, detail: `reachable (http ${r.status})` };
    }
    return { ok: false, error: `n8n_http_${r.status}` };
  } catch (err) {
    return { ok: false, error: `unreachable: ${(err as Error).message}` };
  }
}
