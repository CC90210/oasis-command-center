import "server-only";
import type { VaultServiceCheck, VaultServiceDefinition } from "./catalog";
export { VAULT_SERVICE_DEFINITIONS, vaultServiceDefinition } from "./catalog";

function firstValue(bundle: Record<string, string>, aliases: readonly string[]): string | null {
  for (const key of aliases) {
    const value = bundle[key]?.trim();
    if (value) return value;
  }
  return null;
}

export function vaultServicePresence(definition: VaultServiceDefinition, bundle: Record<string, string>): Record<string, boolean> {
  return Object.fromEntries(definition.keyGroups.map((group) => [group.label, Boolean(firstValue(bundle, group.aliases))]));
}

function baseCheck(definition: VaultServiceDefinition, bundle: Record<string, string>, now: Date): Omit<VaultServiceCheck, "state" | "detail"> {
  return {
    provider: definition.id,
    label: definition.label,
    required_keys: definition.keyGroups.map((group) => group.label),
    present: vaultServicePresence(definition, bundle),
    checked_at: now.toISOString(),
  };
}

function timedFetch(fetchImpl: typeof fetch, input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function normalizeShopifyDomain(raw: string): string | null {
  const stripped = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(stripped) ? stripped : null;
}

export async function checkVaultService(
  definition: VaultServiceDefinition,
  bundle: Record<string, string>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: Date } = {},
): Promise<VaultServiceCheck> {
  const now = options.now ?? new Date();
  const base = baseCheck(definition, bundle, now);
  if (Object.values(base.present).some((present) => !present)) {
    return { ...base, state: "not_configured", detail: "Add every required key, then test again." };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  try {
    if (definition.id === "shopify") {
      const domain = normalizeShopifyDomain(firstValue(bundle, definition.keyGroups[0].aliases) || "");
      const token = firstValue(bundle, definition.keyGroups[1].aliases) || "";
      if (!domain) return { ...base, state: "error", detail: "Use the store's permanent *.myshopify.com domain." };
      const response = await timedFetch(
        fetchImpl,
        `https://${domain}/api/2026-10/graphql.json`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
          body: JSON.stringify({ query: "{ shop { name } }" }),
        },
        timeoutMs,
      );
      if (!response.ok) return { ...base, state: "error", detail: "Shopify refused the saved store domain or token." };
      const body = (await response.json().catch(() => null)) as { data?: { shop?: { name?: unknown } }; errors?: unknown } | null;
      if (!body?.data?.shop || body.errors) return { ...base, state: "error", detail: "Shopify answered, but the token could not read this storefront." };
      const name = typeof body.data.shop.name === "string" ? body.data.shop.name.trim().slice(0, 120) : "";
      return { ...base, state: "connected", detail: name ? `Connected to ${name}.` : "Shopify accepted the saved credentials." };
    }

    if (definition.id === "wise") {
      const token = firstValue(bundle, definition.keyGroups[0].aliases) || "";
      const init = { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } };
      let response = await timedFetch(
        fetchImpl,
        "https://api.wise.com/2026Q4/profiles",
        init,
        timeoutMs,
      );
      // Wise's current docs use api.wise.com, while the established finance
      // integration still uses this legacy-compatible host and v2 route.
      if (!response.ok) {
        response = await timedFetch(fetchImpl, "https://api.transferwise.com/v2/profiles", init, timeoutMs);
      }
      if (!response.ok) return { ...base, state: "error", detail: "Wise refused the saved API token." };
      const body = await response.json().catch(() => null);
      if (!Array.isArray(body)) return { ...base, state: "error", detail: "Wise answered with an unexpected profile response." };
      return { ...base, state: "connected", detail: `Wise accepted the token${body.length ? ` for ${body.length} profile${body.length === 1 ? "" : "s"}` : ""}.` };
    }

    const rawKey = firstValue(bundle, definition.keyGroups[0].aliases) || "";
    const authorization = /^Key\s+/i.test(rawKey) ? rawKey : `Key ${rawKey}`;
    const response = await timedFetch(
      fetchImpl,
      "https://api.higgsfield.ai/requests/00000000-0000-0000-0000-000000000000/status",
      { method: "GET", headers: { Authorization: authorization, Accept: "application/json" } },
      timeoutMs,
    );
    if (response.ok) {
      return { ...base, state: "connected", detail: "Higgsfield accepted the saved API key; no generation was started." };
    }
    // Higgsfield documents 401 for invalid credentials and a JSON
    // ErrorResponse (`{ detail: string }`) with 404 when the request id does
    // not exist or belongs to another account. Only that documented shape is
    // evidence that this authenticated endpoint handled the request; an
    // arbitrary proxy/router 404 must not turn the card green.
    if (response.status === 404) {
      const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
      if (body && typeof body.detail === "string" && body.detail.trim()) {
        return { ...base, state: "connected", detail: "Higgsfield accepted the saved API key; no generation was started." };
      }
    }
    return { ...base, state: "error", detail: "Higgsfield refused the saved API key." };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ...base,
      state: "unreachable",
      detail: timedOut ? `${definition.label} did not answer within ${Math.ceil(timeoutMs / 1000)} seconds.` : `${definition.label} could not be reached just now.`,
    };
  }
}
