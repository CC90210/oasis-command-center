import "server-only";
import type { Client } from "@libsql/client";
import { resolveSessionContext, type SessionContext } from "@/lib/api-auth";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { dbBool } from "@/lib/db-bool";
import { readBodyCapped } from "@/lib/ledger/ingest";
import { getTursoClient } from "@/lib/turso";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { QuoError } from "@/lib/integrations/quo";
import { discoverQuoNumbers, quoSetupState, setupQuoInbound, QuoSetupError, type QuoSetupDeps } from "@/lib/integrations/quo-setup";

const MESSAGES: Record<string, string> = {
  forbidden: "Only the workspace owner can set up incoming texts.",
  missing_credentials: "Save your Quo API key in this connection first.",
  number_not_authorized: "This number is no longer available in your Quo account. Refresh the number list.",
  invalid_number: "Choose one of the numbers returned by Quo.",
  provider_unavailable: "Quo could not be reached or refused the request. Existing setup is unchanged.",
  provider_response_invalid: "Quo returned an incomplete answer. Refresh later; no new setup was completed.",
  number_list_incomplete: "The number list is larger than this setup can safely check. Contact support to finish setup.",
  setup_in_progress: "Another setup request already started. Refresh its status before trying again.",
  registration_uncertain: "Quo may have registered incoming texts, but OASIS could not confirm and save the result. Contact support to check that registration before retrying. Automated texts remain blocked.",
  existing_setup_requires_review: "An incoming-text setup already exists. Check its incoming delivery status; contact support before replacing it.",
  setup_selection_locked: "Setup has already started for another number. Contact support before changing it.",
  configuration_changed: "The saved Quo connection changed during setup. Existing settings were preserved. Contact support to reconcile the registration.",
};
const json = (status: number, value: Record<string, unknown>) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export type QuoSetupRouteDeps = {
  session?: () => Promise<SessionContext>; db?: () => Client; origin?: () => string;
  fetcher?: typeof fetch; credentials?: QuoSetupDeps["credentials"];
};

export async function handleQuoSetup(req: Request, deps: QuoSetupRouteDeps = {}): Promise<Response> {
  try {
    const session = await (deps.session ?? resolveSessionContext)();
    if (!session.ok) return json(401, { ok: false, error: "unauthorized", message: "Sign in again to continue." });
    if (!session.profileId || isRetiredTenant(session.tenantId)) return json(403, { ok: false, error: "forbidden", message: MESSAGES.forbidden });
    const db = (deps.db ?? getTursoClient)();
    // A broad admin grant is insufficient for this provider configuration write.
    // Read the exact active tenant/profile/identity; body and headers cannot pick it.
    const owner = await db.execute({ sql: "SELECT is_owner,team_role FROM user_profiles WHERE id=? AND tenant_id=? AND auth_user_id=? AND deactivated_at IS NULL", args: [session.profileId, session.tenantId, session.userId] });
    if (owner.rows.length !== 1 || !(dbBool(owner.rows[0].is_owner) || owner.rows[0].team_role === "owner")) return json(403, { ok: false, error: "forbidden", message: MESSAGES.forbidden });
    const origin = new URL((deps.origin ?? publicAppBaseUrl)()).origin;
    if (!origin.startsWith("https://")) return json(503, { ok: false, error: "public_origin_unavailable" });
    const setup: QuoSetupDeps = { db, tenantId: session.tenantId, userId: session.userId, origin, fetcher: deps.fetcher, credentials: deps.credentials };
    if (req.method === "GET") {
      const status = await quoSetupState(setup);
      // Durable setup/recovery must remain visible during a provider outage.
      // Only a new registration needs a live list of selectable numbers.
      const numbers = status.state === "idle" ? await discoverQuoNumbers(setup) : [];
      return json(200, { ok: true, numbers, ...status });
    }
    if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
    if (req.headers.get("origin") !== origin) return json(403, { ok: false, error: "origin_refused" });
    const raw = await readBodyCapped(req, 1024);
    if (raw === null) return json(413, { ok: false, error: "body_too_large" });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return json(422, { ok: false, error: "invalid_request" }); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "phoneNumberId") || typeof body.phoneNumberId !== "string") return json(422, { ok: false, error: "invalid_request" });
    return json(200, await setupQuoInbound(body.phoneNumberId, setup));
  } catch (error) {
    const code = error instanceof QuoSetupError ? error.code : error instanceof QuoError && error.code === "missing_credentials" ? "missing_credentials" : "setup_unavailable";
    const status = error instanceof QuoSetupError ? error.status : code === "missing_credentials" ? 409 : 503;
    return json(status, { ok: false, error: code, message: MESSAGES[code] ?? "OASIS could not complete setup. Refresh its status before retrying; no additional registration will start while an earlier result is uncertain." });
  }
}
