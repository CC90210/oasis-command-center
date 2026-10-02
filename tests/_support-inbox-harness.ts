/**
 * Shared harness for tests/support-inbox-*.test.ts: the support@ reader's
 * side of the wire, played by the test.
 *
 * A throwaway local libSQL file (tests/_delivery-harness.ts: migration 183,
 * the ledger, the people) plus the REAL migrations the support inbox builds
 * on (bravo__188 client records, bravo__186 approvals) and its own
 * (bravo__200), and the production shapes of the tables it writes outside
 * its own (email_suppressions, lead_interactions' dedupe index,
 * conversation_threads).
 *
 * Requests are signed HERE, with node:crypto, the way the reader signs them
 * (BEA scripts/support/occ_client.py): HMAC-SHA256 over "<ts>.<raw body>",
 * keyed with the secret as trimmed text. Nothing from the code under test is
 * used to sign, so a broken verifier cannot agree with itself.
 *
 * IMPORT THIS FIRST (it imports the delivery harness, which sets the env).
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { OASIS, setupDatabase, splitSql } from "./_delivery-harness";

export * from "./_delivery-harness";

// Never let a test reach a real channel or flip the send mode.
for (const k of ["BRAVO_FORCE_DRY_RUN", "DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "SUPPORT_INGEST_SECRET_BEA"]) delete process.env[k];

export const SECRET = "support-inbox-test-secret-0123456789abcdef";
export const ENV = { SUPPORT_INGEST_SECRET_BEA: `  ${SECRET}\n` };
export const MAILBOX = "support@oasisai.work";

const ROOT = join(__dirname, "..");
export const SUPPORT_MIGRATION_PATH = join(ROOT, "database", "turso", "bravo__200_support_inbox.sql");
const APPROVALS_MIGRATION = join(ROOT, "database", "turso", "bravo__186_os_approvals.sql");
const CUSTOMERS_MIGRATION = join(ROOT, "database", "turso", "bravo__188_os_customers.sql");

/** The delivery harness's database, plus everything the support inbox reads and writes. */
export async function setupSupportDatabase(): Promise<Client> {
  const db = await setupDatabase();
  for (const stmt of splitSql(readFileSync(CUSTOMERS_MIGRATION, "utf8"))) await db.execute(stmt);
  for (const stmt of splitSql(readFileSync(APPROVALS_MIGRATION, "utf8"))) await db.execute(stmt);
  await db.executeMultiple(`
    ALTER TABLE email_suppressions ADD COLUMN brand TEXT;
    ALTER TABLE email_suppressions ADD COLUMN reason TEXT NOT NULL DEFAULT 'unsubscribe';
    ALTER TABLE email_suppressions ADD COLUMN source TEXT NOT NULL DEFAULT 'web_form';
    CREATE UNIQUE INDEX ux_lead_interactions_provider_msg ON lead_interactions (provider, provider_message_id);
    CREATE TABLE conversation_threads (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, thread_key TEXT NOT NULL, lead_id TEXT,
      contact_phone_e164 TEXT, contact_email TEXT, contact_label TEXT, owner_agent_id TEXT, assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'open', priority TEXT, last_message_at TEXT, last_inbound_at TEXT,
      last_outbound_at TEXT, last_direction TEXT, last_preview TEXT, unread_count INTEGER NOT NULL DEFAULT 0,
      channel_summary TEXT NOT NULL DEFAULT '{}', sources TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
      snoozed_until TEXT, last_read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX conversation_threads_tenant_id_thread_key_key ON conversation_threads (tenant_id, thread_key);
  `);
  // The migration under test, whole: executeMultiple, because its triggers carry their own ";".
  await db.executeMultiple(readFileSync(SUPPORT_MIGRATION_PATH, "utf8"));
  return db;
}

/** A second, empty database: the support inbox's tables are not installed in it. */
export function emptyDatabase(): Client {
  return createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "support-empty-")), "empty.db")}` });
}

const BS = String.fromCharCode(92);

/** JSON as the reader sends it: compact, pure ASCII (every non-ASCII character as a \\u escape). */
export function asciiJson(value: unknown): string {
  return [...JSON.stringify(value)]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 128) return ch;
      // Astral characters arrive as one code point here; emit their UTF-16 pair.
      const units = code > 0xffff ? [Math.floor((code - 0x10000) / 0x400) + 0xd800, ((code - 0x10000) % 0x400) + 0xdc00] : [code];
      return units.map((u) => `${BS}u${u.toString(16).padStart(4, "0")}`).join("");
    })
    .join("");
}

/** The reader's signature: lowercase hex HMAC-SHA256 over "<ts>." + raw body, the trimmed secret as text. */
export function sign(secret: string, ts: number, raw: string): string {
  return createHmac("sha256", secret.trim()).update(`${ts}.${raw}`, "utf8").digest("hex");
}

export type SignOptions = { ts?: number; secret?: string; signature?: string; producer?: string | null; raw?: string; headers?: Record<string, string> };

/** A signed POST to one of the four routes, exactly as the reader builds it. */
export function signedRequest(path: string, body: unknown, now: Date, o: SignOptions = {}): Request {
  const raw = o.raw ?? asciiJson(body);
  const ts = o.ts ?? Math.floor(now.getTime() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "bravo-support-inbox/1.0",
    "x-support-timestamp": String(ts),
    "x-support-signature": o.signature ?? sign(o.secret ?? SECRET, ts, raw),
    ...(o.producer === null ? {} : { "x-support-producer": o.producer ?? "bea" }),
    ...(o.headers ?? {}),
  };
  return new Request(`https://oasisai.work${path}`, { method: "POST", headers, body: raw });
}

let seq = 0;
/** A unique Message-ID, as the reader normalises one ("<id>"). */
export function messageId(tag = "m"): string {
  seq += 1;
  return `<${tag}-${seq}-${Date.now()}@client.example>`;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type WireBody = {
  mailbox: string;
  delivered_to: string;
  origin: string;
  ack_wanted: boolean;
  message: {
    message_id: string | null;
    in_reply_to: string | null;
    references: string[];
    received_at: string;
    from: { address: string; name: string | null };
    reply_to: string | null;
    to: string[];
    cc: string[];
    subject: string;
    body_text: string;
    body_truncated: boolean;
    attachments: Array<{ filename: string; mime_type: string; size: number }>;
    auth: { spf: string | null; dkim: string | null; dmarc: string | null; aligned: boolean };
    auto_submitted: boolean;
    forwarded_by: string | null;
  };
  classification: {
    is_support_request: boolean;
    non_ticket_kind: string | null;
    facet: string;
    urgency: string;
    confidence: number;
    fallback: boolean;
    summary: string;
    opt_out: boolean;
    model_ref: string;
  };
};

/** A support request from a verified client, with every key the contract pins; `over` replaces parts. */
export function ingestBody(over: DeepPartial<WireBody> = {}, now = new Date()): WireBody {
  const base: WireBody = {
    mailbox: MAILBOX,
    delivered_to: MAILBOX,
    origin: "support_inbox",
    ack_wanted: true,
    message: {
      message_id: messageId(),
      in_reply_to: null,
      references: [],
      received_at: new Date(now.getTime() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      from: { address: "jane@harbourplumbing.test", name: "Jane Harbour" },
      reply_to: null,
      to: [MAILBOX],
      cc: [],
      subject: "Contact form on my site returns an error",
      body_text: "Hi team, the contact form on /contact shows an error when I submit it. Can you look?",
      body_truncated: false,
      attachments: [],
      auth: { spf: "pass", dkim: "pass", dmarc: "pass", aligned: true },
      auto_submitted: false,
      forwarded_by: null,
    },
    classification: {
      is_support_request: true,
      non_ticket_kind: null,
      facet: "bug",
      urgency: "high",
      confidence: 0.91,
      fallback: false,
      summary: "Contact form on the client's site errors on submit.",
      opt_out: false,
      model_ref: "claude-cli:opus",
    },
  };
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
    }
    return out;
  };
  return merge(base as unknown as Record<string, unknown>, over as Record<string, unknown>) as unknown as WireBody;
}

export type SentMail = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  idempotencyKey: string;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
  autoSubmitted?: string | null;
  ownTicketReply?: { ticketId: string; requester: string } | null;
};

/** NotifyDeps that record instead of sending, and a schedule() that the test drains. */
export function fakeNotify(opts: { live?: boolean; emailOk?: boolean; emailReason?: string } = {}) {
  const telegrams: string[] = [];
  const emails: SentMail[] = [];
  const events: Array<{ eventType: string; tenantId: string; severity: string; payload: Record<string, unknown> }> = [];
  const tasks: Array<Promise<void>> = [];
  const deps = {
    telegram: async (text: string) => {
      telegrams.push(text);
      return { ok: true };
    },
    email: async (m: SentMail) => {
      emails.push(m);
      return opts.emailOk === false ? { ok: false, reason: opts.emailReason ?? "send_failed: smtp down" } : { ok: true };
    },
    founderEmails: ["conaugh@oasisai.work", "adon@oasisai.work"],
    appOrigin: "https://app.test",
    isDryRun: () => !(opts.live ?? true),
    publishEvent: async (e: { eventType: string; tenantId: string; severity: string; payload: Record<string, unknown> }) => {
      events.push(e);
    },
  };
  const schedule = (task: () => Promise<void>) => {
    tasks.push(task().catch((err) => console.error("[harness.after] threw", err)));
  };
  const drain = async () => {
    while (tasks.length) await tasks.shift();
  };
  return { deps, telegrams, emails, events, schedule, drain };
}

/** Read a JSON answer, and hold every 2xx to the contract: a JSON object with ok: true. */
export async function answerOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (res.status >= 200 && res.status < 300) {
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as { ok?: unknown }).ok !== true) {
      throw new Error(`a ${res.status} answer must be a JSON object with ok: true, got ${text.slice(0, 200)}`);
    }
  } else if (!body || typeof body !== "object" || (body as { ok?: unknown }).ok !== false || !/^[a-z0-9_.:-]{1,64}$/.test(String((body as { error?: unknown }).error))) {
    throw new Error(`a ${res.status} refusal must be {"ok": false, "error": "<short code>"}, got ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

export async function scalar(db: Client, sql: string, args: Array<string | number | null> = []): Promise<unknown> {
  const rs = await db.execute({ sql, args });
  const row = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

/** The tenant every support@ write must land in (OASIS's own desk). */
export const DESK_TENANT = OASIS;
