import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { decryptField, encryptField } from "@/lib/field-encryption";
import { getQuoCredentials, type QuoCredentials } from "@/lib/integrations/quo";
import { QUO_WEBHOOK_VERSION, quoWebhookUrl } from "@/lib/integrations/quo-webhook";

// These rows are internal, encrypted operation records, never editable keys.
// A creating operation has NO automatic expiry: a timed-out provider POST may
// have succeeded. Retrying it blindly could create a second webhook and lose
// the first signing key. Only a stored candidate can be resumed automatically.
const SERVICE = "quo_setup_operation";
const FIELD = "registration";
const PHONE_ID = /^PN[A-Za-z0-9_-]{1,198}$/;
const E164 = /^\+[1-9]\d{9,14}$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Database = Pick<Client | Transaction, "execute">;
type Operation = {
  id: string; phase: "creating" | "registered" | "saved"; phoneId: string;
  apiDigest: string; snapshot: string; bundle?: Record<string, string>;
};
export type QuoSetupNumber = { id: string; number: string; name: string; messaging: Record<string, string> };
export type QuoSetupDeps = {
  db: Client; tenantId: string; userId: string; origin: string;
  fetcher?: typeof fetch; credentials?: typeof getQuoCredentials;
};
export class QuoSetupError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
const fail = (code: string, status = 503): never => { throw new QuoSetupError(code, status); };

async function provider(path: string, key: string, deps: QuoSetupDeps, body?: unknown): Promise<Record<string, unknown>> {
  // Provider responses may contain signing keys. Never log them or return them
  // to the caller. Bounded reads and rejected redirects apply to every request.
  let response: Response;
  try {
    response = await (deps.fetcher ?? fetch)(`https://api.quo.com${path}`, {
      // Workers rejects redirect:error before sending. manual plus the non-2xx
      // check below refuses redirects without forwarding credentials anywhere.
      method: body === undefined ? "GET" : "POST", redirect: "manual", cache: "no-store",
      headers: { Authorization: key, "Quo-Api-Version": QUO_WEBHOOK_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 8_000 : 12_000),
    });
  } catch { return fail("provider_unavailable"); }
  if (!response.ok) { await response.body?.cancel(); return fail("provider_unavailable"); }
  if (!response.body) return fail("provider_response_invalid");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 256 * 1024) { await reader.cancel(); return fail("provider_response_invalid"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { return fail("provider_response_invalid"); }
}

export async function discoverQuoNumbers(deps: QuoSetupDeps, creds?: QuoCredentials): Promise<QuoSetupNumber[]> {
  const credential = creds ?? await (deps.credentials ?? getQuoCredentials)(deps.tenantId);
  const numbers: QuoSetupNumber[] = []; const seen = new Set<string>(); let cursor = "";
  // The current API is paginated; an incomplete list must never look complete.
  for (let page = 0; page < 3; page++) {
    const query = new URLSearchParams({ limit: "50", include: "restrictions", ...(cursor ? { after: cursor } : {}) });
    const result = await provider(`/phone-numbers?${query}`, credential.apiKey, deps);
    if (!Array.isArray(result.data)) return fail("provider_response_invalid");
    for (const raw of result.data) {
      const n = object(raw); const restrictions = object(object(n.restrictions).messaging);
      if (typeof n.id !== "string" || !PHONE_ID.test(n.id) || typeof n.phoneNumber !== "string" || !E164.test(n.phoneNumber) || seen.has(n.id)) return fail("provider_response_invalid");
      seen.add(n.id);
      numbers.push({ id: n.id, number: n.phoneNumber, name: typeof n.name === "string" ? n.name.slice(0, 80) : "",
        messaging: Object.fromEntries(["CA", "US", "Intl"].map(region => [region,
          restrictions[region] === "unrestricted" ? "allowed" : restrictions[region] === "restricted" ? "restricted" : "unknown"])) });
    }
    if (result.nextCursor === null) return numbers;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 2048 || result.nextCursor === cursor) return fail("provider_response_invalid");
    cursor = result.nextCursor;
  }
  return fail("number_list_incomplete");
}

async function snapshot(db: Database, tenantId: string): Promise<string> {
  const result = await db.execute({ sql: "SELECT field_key,encrypted_value FROM tenant_integration_credentials WHERE tenant_id=? AND service='quo' ORDER BY field_key", args: [tenantId] });
  return JSON.stringify(result.rows.map(row => [String(row.field_key), String(row.encrypted_value)]));
}
async function operation(db: Database, tenantId: string): Promise<{ raw: string; value: Operation } | null> {
  const result = await db.execute({ sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE tenant_id=? AND service=? AND field_key=?", args: [tenantId, SERVICE, FIELD] });
  if (!result.rows[0]) return null;
  const raw = String(result.rows[0].encrypted_value);
  const value = JSON.parse(decryptField(raw)) as Operation;
  if (!value.id || !["creating", "registered", "saved"].includes(value.phase) || !PHONE_ID.test(value.phoneId) || typeof value.snapshot !== "string") return fail("operation_unavailable");
  return { raw, value };
}
async function updateOperation(db: Database, tenantId: string, before: string, next: Operation): Promise<string> {
  const encrypted = encryptField(JSON.stringify(next));
  const result = await db.execute({ sql: "UPDATE tenant_integration_credentials SET encrypted_value=?,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND service=? AND field_key=? AND encrypted_value=?",
    args: [encrypted, tenantId, SERVICE, FIELD, before] });
  if (Number(result.rowsAffected) !== 1) return fail("operation_changed", 409);
  return encrypted;
}

const complete = () => ({ ok: true as const, configured: true, ready: false,
  message: "Incoming text handling is configured. Text this Quo number from your own phone, then check incoming delivery. Automated texts stay blocked until that check passes." });

async function finish(deps: QuoSetupDeps, current: { raw: string; value: Operation }, creds: QuoCredentials) {
  const op = current.value;
  if (op.apiDigest !== digest(creds.apiKey)) return fail("configuration_changed", 409);
  if (op.phase === "creating") return fail("registration_uncertain", 409);
  if (!op.bundle || !op.bundle.webhook_key) return fail("operation_unavailable");
  // Encrypt every field before opening the transaction. The credentials and
  // saved operation commit together; any failed row rolls back the entire set.
  const encrypted = Object.entries(op.bundle).map(([key, value]) => [key, encryptField(value)]);
  const tx = await deps.db.transaction("write");
  try {
    const latest = await operation(tx, deps.tenantId);
    if (!latest || latest.value.id !== op.id) return fail("operation_changed", 409);
    if (latest.value.phase === "saved") {
      const rows = JSON.parse(await snapshot(tx, deps.tenantId)) as string[][];
      if (!Object.entries(op.bundle).every(([key, value]) => rows.some(([field, packed]) => field === key && decryptField(packed) === value))) return fail("configuration_changed", 409);
      await tx.rollback(); return complete();
    }
    if (latest.raw !== current.raw || await snapshot(tx, deps.tenantId) !== op.snapshot) return fail("configuration_changed", 409);
    for (const [key, value] of encrypted) {
      await tx.execute({ sql: `INSERT INTO tenant_integration_credentials (id,tenant_id,service,field_key,encrypted_value,created_by,updated_at)
        VALUES (?,?, 'quo',?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_id,service,field_key)
        DO UPDATE SET encrypted_value=excluded.encrypted_value,created_by=excluded.created_by,updated_at=excluded.updated_at,last_tested_at=NULL,last_test_ok=NULL,last_test_error=NULL`,
        args: [randomUUID(), deps.tenantId, key, value, deps.userId] });
    }
    await updateOperation(tx, deps.tenantId, current.raw, { ...op, phase: "saved" });
    await tx.commit(); return complete();
  } catch (error) { await tx.rollback().catch(() => undefined); throw error; }
  finally { tx.close(); }
}

/** Explicit owner action only. No SMS, provider test event, key rotation or deletion. */
export async function setupQuoInbound(phoneId: string, deps: QuoSetupDeps) {
  if (!PHONE_ID.test(phoneId)) return fail("invalid_number", 422);
  // Capture before resolving the key. Capturing afterward could bind a newer
  // row snapshot to an older key read during a concurrent settings edit.
  const initial = await snapshot(deps.db, deps.tenantId);
  const creds = await (deps.credentials ?? getQuoCredentials)(deps.tenantId);
  const existing = await operation(deps.db, deps.tenantId);
  if (existing) {
    if (existing.value.phoneId !== phoneId) return fail("setup_selection_locked", 409);
    return finish(deps, existing, creds);
  }
  if (await snapshot(deps.db, deps.tenantId) !== initial) return fail("configuration_changed", 409);
  if ((JSON.parse(initial) as string[][]).some(([key]) => key.startsWith("webhook_"))) return fail("existing_setup_requires_review", 409);
  const number = (await discoverQuoNumbers(deps, creds)).find(n => n.id === phoneId);
  if (!number) return fail("number_not_authorized", 422);
  const url = quoWebhookUrl(deps.origin, deps.tenantId);
  const webhooks = (await provider("/webhooks", creds.apiKey, deps)).data;
  if (!Array.isArray(webhooks) || webhooks.length > 50) return fail("provider_response_invalid");
  if (webhooks.some(raw => object(raw).url === url)) return fail("existing_setup_requires_review", 409);
  const op: Operation = { id: randomUUID(), phase: "creating", phoneId, snapshot: initial, apiDigest: digest(creds.apiKey) };
  const raw = encryptField(JSON.stringify(op));
  // Claim the source snapshot atomically. An edit during provider discovery
  // must abort without leaving a non-expiring "creating" record, since no
  // provider write has started yet. Later edits remain fenced by finish().
  const claimTx = await deps.db.transaction("write");
  try {
    if (await snapshot(claimTx, deps.tenantId) !== initial) return fail("configuration_changed", 409);
    const claim = await claimTx.execute({ sql: `INSERT INTO tenant_integration_credentials (id,tenant_id,service,field_key,encrypted_value,created_by,updated_at)
      VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_id,service,field_key) DO NOTHING`,
      args: [randomUUID(), deps.tenantId, SERVICE, FIELD, raw, deps.userId] });
    if (Number(claim.rowsAffected) !== 1) return fail("setup_in_progress", 409);
    await claimTx.commit();
  } catch (error) { await claimTx.rollback().catch(() => undefined); throw error; }
  finally { claimTx.close(); }
  let created: Record<string, unknown>;
  try {
    created = object((await provider("/webhooks", creds.apiKey, deps, {
      url, events: ["message.received"], resourceIds: [number.id], status: "enabled", label: "OASIS incoming texts",
    })).data);
    if (typeof created.id !== "string" || !/^\d{1,100}$/.test(created.id) || typeof created.orgId !== "string" || !/^OR[A-Za-z0-9_-]{1,198}$/.test(created.orgId) ||
      created.url !== url || created.status !== "enabled" || created.apiVersion !== QUO_WEBHOOK_VERSION ||
      !Array.isArray(created.events) || created.events.length !== 1 || created.events[0] !== "message.received" ||
      !Array.isArray(created.resourceIds) || created.resourceIds.length !== 1 || created.resourceIds[0] !== number.id ||
      typeof created.key !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(created.key) || Buffer.from(created.key.slice(6), "base64").length < 16 ||
      Buffer.from(created.key.slice(6), "base64").toString("base64").replace(/=+$/, "") !== created.key.slice(6).replace(/=+$/, "")) return fail("registration_uncertain", 409);
  } catch { return fail("registration_uncertain", 409); }
  const registered: Operation = { ...op, phase: "registered", bundle: {
    api_key: creds.apiKey, from_number: number.number, webhook_id: String(created.id), webhook_org_id: String(created.orgId),
    webhook_phone_number_id: number.id, webhook_key: String(created.key),
  } };
  let persisted: string;
  try { persisted = await updateOperation(deps.db, deps.tenantId, raw, registered); }
  catch { return fail("registration_uncertain", 409); }
  return finish(deps, { raw: persisted, value: registered }, creds);
}

type SetupState = { state: Operation["phase"] | "idle" | "needs_review"; selection?: { id: string; number: string } };

export async function quoSetupState(deps: QuoSetupDeps): Promise<SetupState> {
  const op = await operation(deps.db, deps.tenantId);
  if (op?.value.phase === "saved") {
    const rows = JSON.parse(await snapshot(deps.db, deps.tenantId)) as string[][];
    if (!op.value.bundle || !Object.entries(op.value.bundle).every(([key, value]) => rows.some(([field, packed]) => field === key && decryptField(packed) === value))) return { state: "needs_review" };
  }
  if (op?.value.phase === "registered") {
    if (await snapshot(deps.db, deps.tenantId) !== op.value.snapshot) return { state: "needs_review" };
    const number = op.value.bundle?.from_number;
    if (typeof number !== "string" || !E164.test(number)) return fail("operation_unavailable");
    // Only the original selection is exposed. Stored credentials/signing key
    // stay encrypted on the server; recovery needs no provider discovery.
    return { state: "registered", selection: { id: op.value.phoneId, number } };
  }
  return { state: op?.value.phase ?? "idle" };
}
