/**
 * lib/email/tenant-sender.ts - a client workspace's own sending identity:
 * read it, check it, save it (tenant_sender, bravo__202).
 *
 * WHY (2026-10-02). Every send path refused a client workspace before any
 * mailbox was tried: brandForTenant only knew OASIS's and SunBiz's tenants, and
 * nothing anywhere held a client's legal name or postal address, which CASL
 * (s.6(2)) and CAN-SPAM require in every commercial email. Settings > Brand
 * told the owner "OASIS verifies your sending domain during your install", with
 * no way to do it. This module is the stored half: the owner (or an admin)
 * registers the identity, and brandForTenant turns it into the workspace's own
 * brand once the from address is proven. Decision D11: the postal address is
 * required.
 *
 * VERIFIED MEANS PROVEN, CHECKED LIVE EVERY TIME. A from address counts only
 * while it is a mailbox this workspace controls, proven one of two ways:
 *   - "gws": the workspace's Google Workspace mailbox (Settings > Connections >
 *     Google Workspace) IS that address and its last Test passed. Saving a
 *     key clears its test result, so a passing result also means the mailbox
 *     has not changed since it was tested.
 *   - "gmail_oauth": an ACTIVE member of this workspace connected their own
 *     Google account, with permission to send, and that account IS that
 *     address. Google confirmed the address when they connected it.
 * Equality, never "same domain": a teammate's account on acme.com proves
 * nothing about hello@acme.com, and a brand must be able to send as the
 * address it names. (A member's own mailbox on the same domain may still SEND
 * under the brand: mailboxBrandConflict checks the domain at send time.)
 * Both proofs are read from THIS tenant's rows only. A read that fails is
 * "check_failed", never "verified".
 *
 * NOT APPLIED YET IS "NOT SET UP YET". Until bravo__202 is applied, reads
 * answer not_set_up and a save answers table_missing; nothing else changes.
 *
 * TENANT ISOLATION. Every statement names the tenant in its WHERE clause, and
 * callers pass the tenant from the signed-in session, never from a request
 * body. OASIS's own workspaces and the retired client keep their fixed brands
 * (lib/email/brands.ts); app/api/settings/sender refuses to store a row for
 * them, and brandForTenant ignores one if it exists.
 *
 * Not to be confused with lib/email/sending-identity.ts, the environment-set
 * identity of OASIS's own drip mail.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { decryptField } from "@/lib/field-encryption";
import { storedTestResult } from "@/lib/tenant-integration-store";
import { memberStanding } from "@/lib/team";
import { isReservedSendingDomain } from "./brand-for-tenant";

export type SenderVia = "gws" | "gmail_oauth";

/** One tenant_sender row, as stored. */
export type TenantSenderRow = {
  tenant_id: string;
  display_name: string;
  legal_name: string;
  postal_address: string;
  from_address: string;
  reply_to: string | null;
  sending_domain: string;
  verified_via: SenderVia | null;
  verified_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** What the owner typed, after validation. */
export type SenderInput = {
  displayName: string;
  legalName: string;
  postalAddress: string;
  fromAddress: string;
  replyTo: string | null;
};

export type SenderField = "display_name" | "legal_name" | "postal_address" | "from_address" | "reply_to";

/**
 * Why a from address does not count yet:
 *   no_mailbox     no complete Google Workspace mailbox, and no member's own Google account, is that address
 *   other_mailbox  the workspace mailbox is another address (`mailbox` names it)
 *   not_tested     it is the workspace mailbox, but no Test has passed since it was saved
 *   test_failed    it is the workspace mailbox, and its last Test failed
 *   check_failed   the connection rows could not be read; nothing is known
 */
export type SenderVerification =
  | { verified: true; via: SenderVia; mailbox: string }
  | {
      verified: false;
      reason: "no_mailbox" | "other_mailbox" | "not_tested" | "test_failed" | "check_failed";
      mailbox?: string;
    };

/** What loadTenantSender answers; brandForTenant takes it as `sender`. */
export type TenantSenderState =
  | { state: "not_set_up" }
  | { state: "unavailable" }
  | { state: "saved"; sender: TenantSenderRow; verification: SenderVerification };

const TABLE_MISSING = /no such table:\s*tenant_sender\b/i;

export function isTenantSenderTableMissing(err: unknown): boolean {
  return TABLE_MISSING.test(err instanceof Error ? err.message : String(err));
}

const SENDER_COLUMNS =
  "tenant_id, display_name, legal_name, postal_address, from_address, reply_to, sending_domain, " +
  "verified_via, verified_at, created_by, created_at, updated_at";

function rowsOf(rs: ResultSet): Record<string, unknown>[] {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o;
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function toRow(o: Record<string, unknown>): TenantSenderRow {
  const via = text(o.verified_via);
  return {
    tenant_id: text(o.tenant_id),
    display_name: text(o.display_name),
    legal_name: text(o.legal_name),
    postal_address: text(o.postal_address),
    from_address: text(o.from_address),
    reply_to: text(o.reply_to) || null,
    sending_domain: text(o.sending_domain),
    verified_via: via === "gws" || via === "gmail_oauth" ? via : null,
    verified_at: text(o.verified_at) || null,
    created_by: text(o.created_by) || null,
    created_at: text(o.created_at),
    updated_at: text(o.updated_at),
  };
}

// --- validation -------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

function field(body: Record<string, unknown>, key: SenderField): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

type Validated = { ok: true; value: SenderInput } | { ok: false; field: SenderField | null; message: string };

/** An email address, lower-cased, or null when it is not one. */
function emailOrNull(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 254 || !EMAIL.test(v)) return null;
  return v;
}

/**
 * Validate what the owner typed. Pure. Only the five fields are read: a tenant,
 * a verification or a sending domain in the body are ignored, never trusted.
 */
export function validateSenderInput(body: unknown): Validated {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, field: null, message: "Send the sending identity as a form with its five fields." };
  }
  const b = body as Record<string, unknown>;

  const displayName = field(b, "display_name").trim().replace(/\s+/g, " ");
  if (!displayName) return { ok: false, field: "display_name", message: "Enter the business name your emails go out under." };
  if (displayName.length > 80) return { ok: false, field: "display_name", message: "Keep the business name to 80 characters or fewer." };
  // It is printed in front of the From address. A line break there is a header
  // injection, and an address inside the name is how a lookalike sender reads
  // as someone it is not.
  if (CONTROL.test(displayName) || /["<>\\@]/.test(displayName)) {
    return { ok: false, field: "display_name", message: "The business name can't contain quotes, angle brackets, @ or a backslash." };
  }

  const legalName = field(b, "legal_name").trim().replace(/\s+/g, " ");
  if (legalName.length < 2) return { ok: false, field: "legal_name", message: "Enter the business's legal name, as it is registered." };
  if (legalName.length > 160) return { ok: false, field: "legal_name", message: "Keep the legal name to 160 characters or fewer." };
  if (CONTROL.test(legalName)) return { ok: false, field: "legal_name", message: "The legal name has to fit on one line." };

  // One line in every footer: each typed line becomes a comma-separated part.
  const postalAddress = field(b, "postal_address")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " ").replace(/,+$/, ""))
    .filter(Boolean)
    .join(", ");
  if (!postalAddress) {
    return {
      ok: false,
      field: "postal_address",
      message: "Enter a postal address. Anti-spam law (CASL in Canada, CAN-SPAM in the US) requires one in every commercial email.",
    };
  }
  if (CONTROL.test(postalAddress) || postalAddress.length > 300) {
    return { ok: false, field: "postal_address", message: "Keep the postal address to 300 characters or fewer." };
  }
  // A city on its own is not a mailing address (OASIS's own footer said only
  // "Montreal, QC, Canada" until 2026-09-09). Every real one has a number: the
  // street, the PO box or the postal code.
  if (postalAddress.length < 10 || !/\d/.test(postalAddress) || !/[a-z]/i.test(postalAddress)) {
    return {
      ok: false,
      field: "postal_address",
      message: "Enter the full postal address: the street number or PO box, the city and the postal code.",
    };
  }

  const fromAddress = emailOrNull(field(b, "from_address"));
  if (!fromAddress) {
    return { ok: false, field: "from_address", message: "Enter the email address your emails are sent from, like hello@yourbusiness.com." };
  }
  if (isReservedSendingDomain(fromAddress.slice(fromAddress.lastIndexOf("@") + 1))) {
    return { ok: false, field: "from_address", message: "That address can't send this workspace's email. Use an address at your own business." };
  }

  const replyRaw = field(b, "reply_to").trim();
  let replyTo: string | null = null;
  if (replyRaw) {
    replyTo = emailOrNull(replyRaw);
    if (!replyTo) return { ok: false, field: "reply_to", message: "Enter a valid reply-to address, or leave it empty." };
    if (isReservedSendingDomain(replyTo.slice(replyTo.lastIndexOf("@") + 1))) {
      return { ok: false, field: "reply_to", message: "Replies can't go to that address. Use an address at your own business." };
    }
  }

  return { ok: true, value: { displayName, legalName, postalAddress, fromAddress, replyTo } };
}

// --- verification -----------------------------------------------------------

/** The workspace's Google Workspace mailbox ('gws'), as its stored rows describe it. */
export type WorkspaceMailbox =
  | { saved: false }
  /** tested: true = the last Test passed and nothing changed since; false = it failed; null = not tested since saved. */
  | { saved: true; address: string; tested: boolean | null };

export type MailboxFacts = {
  workspace: WorkspaceMailbox;
  /** Addresses of ACTIVE members' own Google accounts that may send. */
  memberGoogle: readonly string[];
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The rule, over facts already read. Pure. The workspace mailbox wins when both prove the address. */
export function decideVerification(fromAddress: string, facts: MailboxFacts): SenderVerification {
  const ws = facts.workspace;
  if (ws.saved && same(ws.address, fromAddress) && ws.tested === true) {
    return { verified: true, via: "gws", mailbox: fromAddress.trim().toLowerCase() };
  }
  if (facts.memberGoogle.some((address) => same(address, fromAddress))) {
    return { verified: true, via: "gmail_oauth", mailbox: fromAddress.trim().toLowerCase() };
  }
  if (ws.saved && same(ws.address, fromAddress)) {
    return { verified: false, reason: ws.tested === false ? "test_failed" : "not_tested" };
  }
  if (ws.saved) return { verified: false, reason: "other_mailbox", mailbox: ws.address.trim().toLowerCase() };
  return { verified: false, reason: "no_mailbox" };
}

const GWS_FIELDS = ["app_password", "from_address"] as const;
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * The workspace mailbox, from ONE read of its stored rows, so the address and
 * its test result describe the same moment. Stored rows only: a client
 * workspace never resolves OASIS's environment mailbox, and a saved value with
 * no test result means it changed after the last Test (the same rule the
 * Connections card reads, lib/os/connectors.ts keyedStatus). A row that will
 * not decrypt throws: that is "could not check", never "not connected".
 */
async function readWorkspaceMailbox(db: Client, tenantId: string): Promise<WorkspaceMailbox> {
  const rows = rowsOf(
    await db.execute({
      sql: `SELECT field_key, encrypted_value, last_tested_at, last_test_ok
            FROM tenant_integration_credentials
            WHERE tenant_id = ? AND service = 'gws'`,
      args: [tenantId],
    }),
  );
  const byField = new Map(rows.map((r) => [text(r.field_key), r]));
  const required = GWS_FIELDS.map((f) => byField.get(f));
  if (required.some((r) => !r || !text(r.encrypted_value))) return { saved: false };
  const address = decryptField(text(byField.get("from_address")!.encrypted_value)).trim().toLowerCase();
  if (!address) return { saved: false };
  // A value saved after the last Test means that Test no longer describes the
  // mailbox, whatever it found; only then does a failure count.
  const results = required.map((r) => (text(r!.last_tested_at) ? storedTestResult(r!.last_test_ok) : null));
  const tested = results.some((t) => t === null) ? null : results.some((t) => t === false) ? false : true;
  return { saved: true, address, tested };
}

/**
 * Members' own Google accounts whose address is `fromAddress` and that can
 * send: a refresh token, the gmail.send permission, and a member who is still
 * ACTIVE here (lib/team memberStanding). One read of this tenant's rows. A
 * member whose stored account will not decrypt cannot send through it either,
 * so it proves nothing and is skipped (and logged).
 */
async function readMemberGoogle(db: Client, tenantId: string, fromAddress: string): Promise<string[]> {
  const rows = rowsOf(
    await db.execute({
      sql: `SELECT user_id, field_key, encrypted_value
            FROM user_integration_credentials
            WHERE tenant_id = ? AND service = 'gmail_oauth'
              AND field_key IN ('gmail_address', 'refresh_token', 'scope')`,
      args: [tenantId],
    }),
  );
  const byUser = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const userId = text(r.user_id);
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, new Map());
    byUser.get(userId)!.set(text(r.field_key), text(r.encrypted_value));
  }
  const matches: string[] = [];
  for (const [userId, fields] of byUser) {
    try {
      const address = decryptField(fields.get("gmail_address") || "").trim().toLowerCase();
      if (!same(address, fromAddress)) continue;
      const refresh = decryptField(fields.get("refresh_token") || "").trim();
      const scopes = decryptField(fields.get("scope") || "").split(/\s+/);
      if (!refresh || !scopes.includes(GMAIL_SEND_SCOPE)) continue;
      matches.push(userId);
    } catch (error) {
      console.error("[tenant-sender.member-google] a member's Google account could not be read; it proves nothing", { tenantId, userId, error });
    }
  }
  const out: string[] = [];
  // Normally one person: the work connection must be the member's own address.
  for (const userId of matches.slice(0, 5)) {
    const { standing } = await memberStanding(tenantId, userId);
    if (standing === "active") out.push(fromAddress.trim().toLowerCase());
  }
  return out;
}

async function readMailboxFacts(db: Client, tenantId: string, fromAddress: string): Promise<MailboxFacts> {
  const workspace = await readWorkspaceMailbox(db, tenantId);
  // The workspace mailbox already proves it: no need to read anyone's account.
  if (workspace.saved && workspace.tested === true && same(workspace.address, fromAddress)) {
    return { workspace, memberGoogle: [] };
  }
  return { workspace, memberGoogle: await readMemberGoogle(db, tenantId, fromAddress) };
}

/** Is `fromAddress` a mailbox `tenantId` controls, right now? Any read failure is check_failed. */
export async function verifySenderMailbox(db: Client, tenantId: string, fromAddress: string): Promise<SenderVerification> {
  if (!tenantId) throw new Error("verifySenderMailbox: tenantId is required");
  try {
    return decideVerification(fromAddress, await readMailboxFacts(db, tenantId, fromAddress));
  } catch (error) {
    console.error("[tenant-sender.verify] the connected mailboxes could not be checked", { tenantId, error });
    return { verified: false, reason: "check_failed" };
  }
}

// --- read -------------------------------------------------------------------

/**
 * This workspace's identity and whether it counts right now. Pass the result
 * to brandForTenant as `sender`. A null db (no database on this deployment) is
 * "unavailable", the table not there yet is "not_set_up", a failed read is
 * "unavailable", never "not set up".
 */
export async function loadTenantSender(db: Client | null, tenantId: string): Promise<TenantSenderState> {
  if (!tenantId) throw new Error("loadTenantSender: tenantId is required");
  if (!db) return { state: "unavailable" };
  let row: TenantSenderRow | null;
  try {
    const rows = rowsOf(
      await db.execute({ sql: `SELECT ${SENDER_COLUMNS} FROM tenant_sender WHERE tenant_id = ? LIMIT 1`, args: [tenantId] }),
    );
    row = rows[0] ? toRow(rows[0]) : null;
  } catch (error) {
    if (isTenantSenderTableMissing(error)) return { state: "not_set_up" };
    console.error("[tenant-sender.load]", { tenantId, error });
    return { state: "unavailable" };
  }
  if (!row) return { state: "not_set_up" };
  return { state: "saved", sender: row, verification: await verifySenderMailbox(db, tenantId, row.from_address) };
}

// --- save -------------------------------------------------------------------

/**
 * Store this workspace's identity and its audit row in ONE batch: both land or
 * neither does. The audit row records the identity before and after (none of
 * it is secret: every email prints it). verified_via and verified_at record
 * what the live check found at this save; reads check again.
 */
export async function saveTenantSender(
  db: Client,
  args: { tenantId: string; actorUserId: string | null; input: SenderInput; verification: SenderVerification; now: Date },
): Promise<{ ok: true; sender: TenantSenderRow } | { ok: false; reason: "table_missing" }> {
  const { tenantId, input } = args;
  if (!tenantId) throw new Error("saveTenantSender: tenantId is required");
  const nowIso = args.now.toISOString();
  const domain = input.fromAddress.slice(input.fromAddress.lastIndexOf("@") + 1);
  const verifiedVia = args.verification.verified ? args.verification.via : null;
  const after = {
    display_name: input.displayName,
    legal_name: input.legalName,
    postal_address: input.postalAddress,
    from_address: input.fromAddress,
    reply_to: input.replyTo,
    verified_via: verifiedVia,
  };
  const stmts: InStatement[] = [
    {
      sql: `INSERT INTO tenant_audit_log (id, tenant_id, actor_user_id, action_type, target_table, target_id, before, after, metadata, created_at)
            SELECT ?, ?, ?, 'sending_identity.saved', 'sending identity', ?,
              (SELECT json_object('display_name', display_name, 'legal_name', legal_name, 'postal_address', postal_address,
                                  'from_address', from_address, 'reply_to', reply_to, 'verified_via', verified_via)
               FROM tenant_sender WHERE tenant_id = ?),
              ?, '{}', ?`,
      args: [randomUUID(), tenantId, args.actorUserId, tenantId, tenantId, JSON.stringify(after), nowIso],
    },
    {
      sql: `INSERT INTO tenant_sender (${SENDER_COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id) DO UPDATE SET
              display_name = excluded.display_name,
              legal_name = excluded.legal_name,
              postal_address = excluded.postal_address,
              from_address = excluded.from_address,
              reply_to = excluded.reply_to,
              sending_domain = excluded.sending_domain,
              verified_via = excluded.verified_via,
              verified_at = excluded.verified_at,
              updated_at = excluded.updated_at`,
      args: [
        tenantId,
        input.displayName,
        input.legalName,
        input.postalAddress,
        input.fromAddress,
        input.replyTo,
        domain,
        verifiedVia,
        verifiedVia ? nowIso : null,
        args.actorUserId,
        nowIso,
        nowIso,
      ],
    },
    { sql: `SELECT ${SENDER_COLUMNS} FROM tenant_sender WHERE tenant_id = ?`, args: [tenantId] },
  ];
  let results: ResultSet[];
  try {
    results = await db.batch(stmts, "write");
  } catch (error) {
    if (isTenantSenderTableMissing(error)) return { ok: false, reason: "table_missing" };
    throw error;
  }
  const saved = rowsOf(results[2])[0];
  if (!saved) throw new Error("saveTenantSender: the saved identity could not be read back");
  return { ok: true, sender: toRow(saved) };
}

// --- what the owner reads ---------------------------------------------------

export type SenderStatus = { kind: "connected" | "attention" | "not_connected" | "unknown"; label: string; detail: string };

const CONNECT_PATH = "Settings > Connections > Google Workspace";

/** The one line Settings > Brand shows, and what to do next. Never a table, code or vendor name. */
export function describeSender(state: TenantSenderState): SenderStatus {
  if (state.state === "unavailable") {
    return {
      kind: "unknown",
      label: "Couldn't check",
      detail: "The sending identity could not be read right now. That does not mean it is missing; refresh to try again.",
    };
  }
  if (state.state === "not_set_up") {
    return {
      kind: "not_connected",
      label: "Not set up yet",
      detail: "No email goes out under this workspace's name until these details are saved and the sending address is verified.",
    };
  }
  const v = state.verification;
  const from = state.sender.from_address;
  if (v.verified) {
    return {
      kind: "connected",
      label: `Verified through ${v.mailbox}`,
      detail:
        v.via === "gws"
          ? `${v.mailbox} is this workspace's Google Workspace mailbox, and its last test passed.`
          : `${v.mailbox} is a team member's own Google account, connected with permission to send.`,
    };
  }
  switch (v.reason) {
    case "other_mailbox":
      return {
        kind: "attention",
        label: "Not verified yet",
        detail: `The mailbox connected in ${CONNECT_PATH} is ${v.mailbox ?? "another address"}, not ${from}. Connect ${from} there and press Test, or use ${v.mailbox ?? "that address"} as the sending address.`,
      };
    case "not_tested":
      return {
        kind: "attention",
        label: "Not verified yet",
        detail: `${from} is connected but has not passed a test since it was saved. Press Test in ${CONNECT_PATH}.`,
      };
    case "test_failed":
      return {
        kind: "attention",
        label: "Not verified yet",
        detail: `The last test of ${from} failed. Check its App Password in ${CONNECT_PATH} and press Test again.`,
      };
    case "check_failed":
      return {
        kind: "unknown",
        label: "Couldn't check",
        detail: "The connected mailboxes could not be checked right now. Nothing is sent under this identity until the check passes; refresh to try again.",
      };
    default:
      return {
        kind: "attention",
        label: "Not verified yet",
        detail: `Connect ${from} in ${CONNECT_PATH} and press Test. Until then no email goes out under this identity.`,
      };
  }
}
