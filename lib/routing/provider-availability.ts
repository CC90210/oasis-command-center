/**
 * lib/routing/provider-availability.ts — what can actually send, right now.
 *
 * Feeds the pure policy in outbound-routing.ts. Kept separate so the allocation
 * rules stay testable without a database, and so "we have no Twilio account" is
 * a routing INPUT rather than an exception thrown halfway through a send.
 *
 * Two independent flags per provider, and conflating them is a bug:
 *   configured — credentials exist. A fact about the world.
 *   enabled    — we have decided to use it. A decision, kill-switchable by env.
 *
 * Deliberately does NOT ask whether a provider is currently HEALTHY. A dead
 * mailbox password (SunBiz, 2026-08-07) still counts as configured, because
 * routing around a transient outage by silently sending as the other brand is
 * the two-names-on-one-thread failure the split exists to prevent. Health
 * belongs to the breaker and the health checks; allocation belongs here.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { ProviderAvailability, ProviderId } from "./outbound-routing";

/** Credential service names as stored in tenant_integration_credentials. */
const CREDENTIAL_SERVICE: Record<ProviderId, string> = {
  gws: "gws",
  gws_bluerise: "gws_bluerise",
  texttorrent: "texttorrent",
  twilio: "twilio",
};

/**
 * The fields a provider needs before it can actually send. Outer array = OR,
 * inner array = AND.
 *
 * A service row existing is NOT the same as a usable credential. A TextTorrent
 * row holding only api_sid would report configured, the gate would allow the
 * send, and getTextTorrentCredentials would then fail it — converting a clean
 * hold into a burned attempt and a failed drip. Half-provisioned must read as
 * not provisioned.
 */
const REQUIRED_FIELDS: Record<ProviderId, string[][]> = {
  gws: [["app_password", "from_address"]],
  gws_bluerise: [["app_password", "from_address"]],
  // api_key doubles as SID and public key in the legacy shape, so either bundle
  // is genuinely sendable.
  texttorrent: [["api_sid", "api_public_key"], ["api_key"]],
  twilio: [["account_sid", "auth_token"]],
};

/** Per-provider kill switch. Set to "0" to stop using a provider without
 *  deleting its credentials. */
const ENABLE_ENV: Record<ProviderId, string> = {
  gws: "PROVIDER_GWS_ENABLED",
  gws_bluerise: "PROVIDER_GWS_BLUERISE_ENABLED",
  texttorrent: "PROVIDER_TEXTTORRENT_ENABLED",
  twilio: "PROVIDER_TWILIO_ENABLED",
};

/**
 * Twilio ships OFF even once credentials appear.
 *
 * US carriers hard-block unregistered 10DLC traffic and BILL for the blocked
 * messages (Twilio error 30034). Having an account is not the same as being
 * allowed to send, so turning Twilio on must be a deliberate act after Bluerise
 * clears carrier registration — never an automatic consequence of a key landing
 * in the environment.
 */
const DEFAULT_ENABLED: Record<ProviderId, boolean> = {
  gws: true,
  gws_bluerise: true,
  texttorrent: true,
  twilio: false,
};

function envEnabled(p: ProviderId): boolean {
  const raw = process.env[ENABLE_ENV[p]];
  if (raw === undefined || raw === "") return DEFAULT_ENABLED[p];
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Read which providers hold credentials for this tenant.
 *
 * FAILS CLOSED on an unreadable credential store: every provider reports
 * unconfigured, so routeOutbound holds everything rather than sending on an
 * assumption. A hold reschedules and costs time; a wrong guess costs a merchant
 * the wrong company's name.
 */
export async function loadProviderAvailability(tenantId: string): Promise<ProviderAvailability> {
  const ids = Object.keys(CREDENTIAL_SERVICE) as ProviderId[];
  const none: ProviderAvailability = Object.fromEntries(
    ids.map((p) => [p, { configured: false, enabled: false }]),
  ) as ProviderAvailability;

  // field_key too, not just service: a row's existence says nothing about
  // whether the bundle is complete enough to send with.
  const fieldsByService = new Map<string, Set<string>>();
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("tenant_integration_credentials")
      .select("service, field_key")
      .eq("tenant_id", tenantId);
    if (r.error) {
      console.error("[provider-availability] credential read failed, holding everything", r.error.message);
      return none;
    }
    for (const row of r.data || []) {
      const svc = String(row.service);
      const set = fieldsByService.get(svc) ?? new Set<string>();
      set.add(String(row.field_key));
      fieldsByService.set(svc, set);
    }
  } catch (err) {
    console.error("[provider-availability] credential read threw, holding everything", err);
    return none;
  }

  const hasCompleteBundle = (p: ProviderId): boolean => {
    const have = fieldsByService.get(CREDENTIAL_SERVICE[p]);
    if (!have) return false;
    return REQUIRED_FIELDS[p].some((bundle) => bundle.every((f) => have.has(f)));
  };

  // Env-provided credentials count too: TextTorrent has historically been
  // configured that way, and a provider that works must not read as absent.
  //
  // These names MUST match ENV_FALLBACKS in lib/tenant-integration-store.ts,
  // which is the resolver's source of truth. Inventing a plausible-looking name
  // here (GWS_APP_PASSWORD rather than the real GMAIL_APP_PASSWORD) reports a
  // working mailbox as unprovisioned and holds all of its traffic — a wrong
  // guess about our own configuration, dressed as a safety check.
  //
  // gws_bluerise is deliberately absent: it has no ENV_FALLBACKS entry and is
  // DB-only, so there is no env path to check.
  const envConfigured: Partial<Record<ProviderId, boolean>> = {
    texttorrent: Boolean(process.env.TEXTTORRENT_API_SID),
    twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    gws: Boolean(process.env.GMAIL_APP_PASSWORD),
  };

  return Object.fromEntries(
    ids.map((p) => {
      const configured = hasCompleteBundle(p) || Boolean(envConfigured[p]);
      return [p, { configured, enabled: configured && envEnabled(p) }];
    }),
  ) as ProviderAvailability;
}
