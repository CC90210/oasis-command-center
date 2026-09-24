/**
 * deactivated-assignee-notifications.test.ts — a lead whose owner has been
 * deactivated keeps that owner's NAME, but the owner is no longer a recipient.
 *
 * getTenantMembers() became active-only on 2026-09-24. Two lookups resolve a
 * lead's assigned_to through it, and a won/in-delivery lead keeps its
 * deactivated owner for history, so both started finding nobody:
 *
 *   - lib/notify/form-completion-email.ts  SunBiz internal notice to the agent
 *                                          + submissions@ when a form completes
 *   - lib/leads/assignee-email.ts          OASIS lead-email Cc / Reply-To
 *
 * Both are driven for real against a local libSQL database. The only stand-ins
 * are the SunBiz mailbox credential loader and nodemailer, which records the
 * message instead of opening SMTP.
 *
 * Run: node --conditions=react-server --import tsx tests/deactivated-assignee-notifications.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "deactivated-assignee-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
// Never let a test reach Google, a bridge, SMTP or Telegram, whatever the
// developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|SUNBIZ_TELEGRAM|TELEGRAM_)/.test(key)) delete process.env[key];
}

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

// The mailbox is asked for per tenant; record which one, so a notice can never
// be shown reaching another tenant's inbox.
const credentialAsks: string[] = [];
stubModule(require.resolve("../lib/integrations/submissions-gmail"), {
  getSubmissionsCreds: async (tenantId: string) => {
    credentialAsks.push(tenantId);
    return { fromAddress: "submissions@sun.test", appPassword: "test-only" };
  },
  getSubmissionsFrom: async () => "SunBiz Submissions <submissions@sun.test>",
});

type SentMail = { from: string; to: string[]; subject: string; text: string };
const sent: SentMail[] = [];
stubModule(require.resolve("nodemailer"), {
  createTransport: () => ({
    sendMail: async (mail: SentMail) => {
      sent.push(mail);
      return { messageId: "test" };
    },
  }),
});

const TENANT = "7d7d7d7d-0000-4000-8000-00000000007d";
const OTHER_TENANT = "7e7e7e7e-0000-4000-8000-00000000007e";
const ACTIVE_REP = "0e0e0e0e-0000-4000-8000-000000000002";
const RETIRED_REP = "0e0e0e0e-0000-4000-8000-000000000003";
const NOBODY = "0e0e0e0e-0000-4000-8000-0000000000ff";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: unknown[][] }> {
  const warned: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = original;
  }
}

/** The one lead read sendFormCompletionEmail makes. */
function leadDb(assignedTo: string | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: { data: { business_name: "Digits Co", contact_name: "Dana Merchant", assigned_to: assignedTo } },
      error: null,
    }),
  };
  return { from: () => chain };
}

async function main() {
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      full_name TEXT, display_name TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
  `);
  const profile = (id: string, tenantId: string, authId: string, email: string, name: string, deactivatedAt: string | null) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at, deactivated_at)
          VALUES (?, ?, ?, ?, 'agent', ?, '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, email, tenantId, name, deactivatedAt],
  });
  await seed.batch(
    [
      profile("p-riley", TENANT, ACTIVE_REP, "riley@t.test", "Riley Active", null),
      profile("p-ethan", TENANT, RETIRED_REP, "ethan@t.test", "Ethan Retired", "2026-09-24T12:00:00Z"),
      // The same person on another tenant, still active there. The lookup is
      // tenant-scoped, so this row must never be what resolves them.
      profile("p-ethan-other", OTHER_TENANT, RETIRED_REP, "ethan@other.test", "Ethan Elsewhere", null),
    ],
    "write",
  );

  // ── lib/notify/form-completion-email.ts (SunBiz, internal) ────────────────
  const { sendFormCompletionEmail } = await import("../lib/notify/form-completion-email");
  const complete = async (assignedTo: string | null) => {
    sent.length = 0;
    credentialAsks.length = 0;
    const { warned } = await captureWarn(() =>
      sendFormCompletionEmail({
        db: leadDb(assignedTo) as never,
        tenantId: TENANT,
        leadId: "lead-1",
        formNumber: 2,
        origin: "https://oasisai.work",
        submittedVia: "email",
      }),
    );
    assert.equal(sent.length, 1, "exactly one notice is sent");
    assert.deepEqual(credentialAsks, [TENANT], "only the lead's own tenant mailbox is used");
    return { mail: sent[0], warned };
  };
  const deactivationWarning = (warned: unknown[][], tag: string) => warned.find((args) => args[0] === tag);

  await check("form completion: an active agent is emailed alongside submissions@, unchanged", async () => {
    const { mail, warned } = await complete(ACTIVE_REP);
    assert.deepEqual(mail.to, ["riley@t.test", "submissions@sun.test"]);
    assert.match(mail.text, /^Riley Active's lead just completed/m);
    assert.match(mail.text, /^Agent: Riley Active$/m);
    assert.equal(deactivationWarning(warned, "[form-completion-email] assignee deactivated"), undefined);
  });

  await check("form completion: a deactivated agent is not emailed; submissions@ still is, and names them inactive", async () => {
    const { mail, warned } = await complete(RETIRED_REP);
    // Also excludes ethan@other.test: his still-active row on another tenant
    // must never supply the recipient.
    assert.deepEqual(mail.to, ["submissions@sun.test"], "a deactivated agent must not receive the lead notice");
    assert.match(mail.text, /^Ethan Retired's lead just completed/m, "the name is history and still resolves");
    assert.match(mail.text, /^Agent: Ethan Retired \(inactive\)$/m);
    const tagged = deactivationWarning(warned, "[form-completion-email] assignee deactivated");
    assert.ok(tagged, "withholding the agent's copy must be visible in the logs");
    assert.equal((tagged[1] as { leadId?: string }).leadId, "lead-1");
    assert.equal((tagged[1] as { assignedTo?: string }).assignedTo, RETIRED_REP);
  });

  await check("form completion: an id matching no member still reads as unassigned, to submissions@ only", async () => {
    const { mail, warned } = await complete(NOBODY);
    assert.deepEqual(mail.to, ["submissions@sun.test"]);
    assert.match(mail.text, /^A lead just completed/m);
    assert.match(mail.text, /^Agent: \(unassigned\)$/m);
    assert.equal(deactivationWarning(warned, "[form-completion-email] assignee deactivated"), undefined);
  });

  await check("form completion: an unassigned lead is unchanged", async () => {
    const { mail } = await complete(null);
    assert.deepEqual(mail.to, ["submissions@sun.test"]);
    assert.match(mail.text, /^Agent: \(unassigned\)$/m);
  });

  // ── lib/leads/assignee-email.ts (OASIS lead-email Cc / Reply-To) ──────────
  const { resolveAssigneeEmail } = await import("../lib/leads/assignee-email");

  await check("assignee email: an active owner resolves to their address, unchanged", async () => {
    const { result, warned } = await captureWarn(() => resolveAssigneeEmail(TENANT, ACTIVE_REP));
    assert.deepEqual(result, { status: "resolved", email: "riley@t.test" });
    assert.equal(deactivationWarning(warned, "[assignee-email] assignee deactivated"), undefined);
  });

  await check("assignee email: a deactivated owner is reported as deactivated, never resolved, and logged", async () => {
    // Upper-cased on purpose: the id match is case-insensitive.
    const { result, warned } = await captureWarn(() => resolveAssigneeEmail(TENANT, RETIRED_REP.toUpperCase()));
    assert.deepEqual(result, { status: "deactivated" }, "a retired rep must not be copied or become the Reply-To");
    const tagged = deactivationWarning(warned, "[assignee-email] assignee deactivated");
    assert.ok(tagged, "the withheld copy must be visible in the logs");
    assert.equal((tagged[1] as { assignedTo?: string }).assignedTo, RETIRED_REP);
    assert.equal((tagged[1] as { tenantId?: string }).tenantId, TENANT);
  });

  await check("assignee email: the same person active on another tenant resolves there only", async () => {
    const result = await resolveAssigneeEmail(OTHER_TENANT, RETIRED_REP);
    assert.deepEqual(result, { status: "resolved", email: "ethan@other.test" });
  });

  await check("assignee email: an id matching no member is still no_address", async () => {
    const { result, warned } = await captureWarn(() => resolveAssigneeEmail(TENANT, NOBODY));
    assert.deepEqual(result, { status: "no_address" });
    assert.equal(deactivationWarning(warned, "[assignee-email] assignee deactivated"), undefined);
  });

  await check("assignee email: no assignee is still unassigned", async () => {
    assert.deepEqual(await resolveAssigneeEmail(TENANT, null), { status: "unassigned" });
    assert.deepEqual(await resolveAssigneeEmail(TENANT, "  "), { status: "unassigned" });
  });

  if (failures) {
    console.error(`deactivated-assignee notifications: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("deactivated-assignee notifications: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
