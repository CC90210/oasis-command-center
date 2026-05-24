/**
 * Secret redaction — server-only.
 *
 * Any string headed for chat_messages (assistantText, error messages),
 * structured logs, or SSE error events is funnelled through `redactSecrets()`
 * first. Risk vectors:
 *
 *   1. Provider error bodies (OpenAI/Anthropic/OpenRouter/Google) can echo
 *      back portions of the request, which include the API key in headers
 *      OR (Google) the URL query string.
 *   2. The model itself could echo a key it saw in a tool result or context.
 *   3. Streaming errors get persisted to `chat_messages.error` — Supabase
 *      table, accessible to anyone with read on that row.
 *
 * Strategy: snapshot every credential-shaped env var value at module init,
 * sort by length DESC (so we don't half-scrub a value that contains another
 * value as substring), replace each occurrence with `[REDACTED:NAME]`.
 *
 * This is defense-in-depth. Provider APIs SHOULD never echo keys; the model
 * SHOULD never repeat secrets. But "should never" is the wrong reliability
 * floor for credentials.
 */

const CRED_NAME_PAT = /(KEY|TOKEN|SECRET|PASSWORD|API|DSN|WEBHOOK)$/;
const ENV_NAME_PAT = /^[A-Z][A-Z0-9_]{2,63}$/;
const MIN_REDACTABLE_LEN = 12;

let cachedPairs: Array<[string, string]> | null = null;

function loadPairs(): Array<[string, string]> {
  if (cachedPairs) return cachedPairs;
  const out: Map<string, string> = new Map();
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length < MIN_REDACTABLE_LEN) continue;
    if (!ENV_NAME_PAT.test(k)) continue;
    if (!CRED_NAME_PAT.test(k)) continue;
    out.set(k, v);
  }
  cachedPairs = Array.from(out.entries()).sort(
    (a, b) => b[1].length - a[1].length
  );
  return cachedPairs;
}

export function redactSecrets(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let out = String(text);
  for (const [name, value] of loadPairs()) {
    if (value && out.includes(value)) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return out;
}

/** Strip `?key=...` and `&api_key=...` query params from URL-shaped substrings. */
export function redactUrlKeyParams(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return String(text)
    .replace(/([?&])(key|api_key|apikey|access_token)=[^&\s"'<>]+/gi, "$1$2=[REDACTED]");
}

export function redactAll(text: string | null | undefined): string {
  return redactSecrets(redactUrlKeyParams(text));
}

/**
 * Tenant vault secret redaction — runtime variant that takes a list of
 * (KEY, value) pairs fetched from `tenant_integration_credentials`
 * with `service="custom"` and scrubs them from text the same way
 * `redactSecrets` scrubs env-var values.
 *
 * Why a runtime variant instead of folding into the cached env-var
 * pairs: tenant vault values are dynamic per-tenant and change as
 * admins paste/delete entries. Caching at module init the way
 * `loadPairs()` does would leak one tenant's secrets into another
 * tenant's redaction pass (or worse, never refresh until process
 * restart). Per-request fetch is the right cost model — one extra
 * SELECT per chat turn that touches the cloud system prompt, only
 * runs when the tenant has at least one vault entry.
 *
 * Callers fetch via `fetchTenantVaultSecrets(tenantId)` then pass
 * the result here. The two-step shape lets the caller hoist the
 * fetch above streaming so each delta doesn't pay for a round-trip.
 *
 * Sorted by value length DESC so a long secret containing a short
 * secret as substring doesn't half-scrub. Same MIN_REDACTABLE_LEN
 * guard as env-var redaction so trivial 1-2-char "secrets" don't
 * create runaway false positives.
 */
export type VaultSecret = { key: string; value: string };

export function redactTenantVaultSecrets(
  text: string | null | undefined,
  secrets: VaultSecret[] | null | undefined,
): string {
  if (!text) return text ?? "";
  if (!secrets || secrets.length === 0) return String(text);
  let out = String(text);
  // Length-DESC ensures substring conflicts resolve in favor of the
  // longer match — same invariant as redactSecrets above.
  const sorted = [...secrets]
    .filter((s) => s.value && s.value.length >= MIN_REDACTABLE_LEN)
    .sort((a, b) => b.value.length - a.value.length);
  for (const { key, value } of sorted) {
    if (out.includes(value)) {
      out = out.split(value).join(`[REDACTED:${key.toUpperCase()}]`);
    }
  }
  return out;
}
