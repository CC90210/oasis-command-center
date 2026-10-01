/**
 * support-sender.test.ts - OASIS's system mail to its clients leaves FROM
 * support@oasisai.work once SUPPORT_GMAIL_USER + SUPPORT_GMAIL_APP_PASSWORD
 * are set, keeps its previous mailbox (and logs ONE line saying so) until then,
 * and answers to support@ (Reply-To) either way. Sales mail never reads the
 * support credential.
 *
 * Driven for real: the shared OASIS sender, the support desk's mail deps, the
 * approvals executor, the Clients-hub mailbox resolver, the invoice mailer and
 * the account-security mailer. The stand-ins are nodemailer (records the SMTP
 * login and the message), the opt-out lookup (nobody suppressed) and the tenant
 * credential store (the shared OASIS mailbox row).
 *
 * Run: node --conditions=react-server --import tsx tests/support-sender.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(__dirname, "..");
// Never let a test reach a real mailbox, whatever the developer's shell holds.
for (const k of [
  "SUPPORT_GMAIL_USER",
  "SUPPORT_GMAIL_APP_PASSWORD",
  "OASIS_MAIL_FROM",
  "OASIS_MAIL_APP_PASSWORD",
  "OASIS_FROM_NAME",
  "INVOICE_FROM_EMAIL",
  "INVOICE_FROM_APP_PASSWORD",
  "INVOICE_FROM_NAME",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "AUTH_SMTP_HOST",
  "AUTH_SMTP_PORT",
  "AUTH_SMTP_USER",
  "AUTH_SMTP_PASSWORD",
  "AUTH_SMTP_SECURE",
  "AUTH_FROM_EMAIL",
  "AUTH_FROM_NAME",
  "AUTH_ALLOWED_FROM_DOMAINS",
  "OASIS_TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
]) {
  delete process.env[k];
}

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type Sent = { auth: { user: string; pass: string }; mail: Record<string, unknown> };
const sent: Sent[] = [];
stubModule(require.resolve("nodemailer"), {
  createTransport: (opts: { auth: { user: string; pass: string } }) => ({
    sendMail: async (mail: Record<string, unknown>) => {
      sent.push({ auth: opts.auth, mail });
      return { messageId: `<t-${sent.length}@oasisai.work>`, accepted: [String(mail.to)], rejected: [] };
    },
  }),
});
stubModule(require.resolve("../lib/lead-interactions-queries"), {
  checkEmailSuppressed: async () => ({ suppressed: false, checkFailed: false }),
});
/** The shared OASIS mailbox row (service oasis_gmail), as a deployment that configured it holds it. */
let oasisRow: Record<string, string> = {};
stubModule(require.resolve("../lib/tenant-integration-store"), {
  getTenantIntegrationBundle: async (_tenantId: string, service: string) => (service === "oasis_gmail" ? oasisRow : {}),
});
// Server modules on the desk's import path read these; nothing here calls them.
stubModule(require.resolve("next/headers"), {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stubModule(require.resolve("next/navigation"), {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

const OASIS_TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUPPORT = "support@oasisai.work";
const SHARED = "team@oasisai.work";
const CLIENT = "client@example.test";
const REP = "rep@oasisai.work";

function setSupport(user: string | null, password = "abcd efgh ijkl mnop") {
  if (user === null) {
    delete process.env.SUPPORT_GMAIL_USER;
    delete process.env.SUPPORT_GMAIL_APP_PASSWORD;
  } else {
    process.env.SUPPORT_GMAIL_USER = user;
    process.env.SUPPORT_GMAIL_APP_PASSWORD = password;
  }
}

/** Run `fn`, recording console.warn / console.error lines instead of printing them. */
async function logsOf<T>(fn: () => Promise<T>): Promise<{ result: T; warn: string[]; error: string[] }> {
  const warn: string[] = [];
  const error: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => void warn.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void error.push(a.map(String).join(" "));
  try {
    return { result: await fn(), warn, error };
  } finally {
    console.warn = w;
    console.error = e;
  }
}
const supportLines = (lines: string[]) => lines.filter((l) => l.startsWith("[support-mail]"));
const last = () => sent[sent.length - 1];

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  console.log("support-sender:");
  const { resolveSupportMailbox } = await import("../lib/email/support-mailbox");
  const { OASIS_SUPPORT_FOOTER, appendSignatureAndFooter } = await import("../lib/config/email-signature");
  const { sendOasisSharedGmail, composeOasisMessage, resolveOasisSupportMailboxFrom } = await import(
    "../lib/integrations/oasis-shared-gmail-send"
  );

  await check("the support credential counts only when it is support@ itself", () => {
    const none = resolveSupportMailbox({});
    assert.equal(none.ok, false);
    if (!none.ok) assert.match(none.detail, /SUPPORT_GMAIL_USER and SUPPORT_GMAIL_APP_PASSWORD not set/);
    const ok = resolveSupportMailbox({ SUPPORT_GMAIL_USER: " Support@OasisAI.work ", SUPPORT_GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" });
    assert.deepEqual(ok, { ok: true, address: SUPPORT, password: "abcdefghijklmnop" }, "case, spaces and app-password grouping are normalised");
    const other = resolveSupportMailbox({ SUPPORT_GMAIL_USER: SHARED, SUPPORT_GMAIL_APP_PASSWORD: "x" });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.reason, "wrong_mailbox");
    assert.equal(resolveSupportMailbox({ SUPPORT_GMAIL_USER: SUPPORT, SUPPORT_GMAIL_APP_PASSWORD: "  " }).ok, false);
  });

  const ack = {
    tenantId: OASIS_TENANT,
    to: CLIENT,
    subject: "We received your request (T-0001)",
    body: "Hi Ana,\n\nThanks for getting in touch.\n\nThe OASIS team",
    idempotencyKey: "support-ack:t1",
    purpose: "support" as const,
  };

  await check("support mail leaves FROM support@ once SUPPORT_* is set, even with the shared mailbox configured", async () => {
    setSupport(SUPPORT);
    oasisRow = { from_address: SHARED, app_password: "row-password" };
    const { result, warn, error } = await logsOf(() => sendOasisSharedGmail(ack));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(last().auth, { user: SUPPORT, pass: "abcdefghijklmnop" }, "the SMTP login is the support mailbox");
    assert.equal(last().mail.from, `"OASIS AI Support" <${SUPPORT}>`);
    assert.equal(last().mail.replyTo, SUPPORT);
    assert.deepEqual(last().mail.headers, { "List-Unsubscribe": `<mailto:${SUPPORT}?subject=UNSUBSCRIBE>` });
    if (result.ok) assert.equal(result.from_address, SUPPORT);
    assert.deepEqual(supportLines([...warn, ...error]), [], "nothing to report when support@ sends");
  });

  await check("support mail is signed by its own body, never 'Support', and closes with the support footer", () => {
    const text = String(last().mail.text);
    assert.ok(text.endsWith(OASIS_SUPPORT_FOOTER), text);
    assert.ok(text.startsWith(`${ack.body}\n\n---\n`), "no sign-off derived from the mailbox address");
    assert.doesNotMatch(text, /\n\nSupport\n/);
    assert.doesNotMatch(text, /reached out about your business/, "the outreach consent sentence is false on a support reply");
    assert.ok(!JSON.stringify(last().mail).toLowerCase().includes("conaugh@oasisai.work"), "no client-facing email names CC");
  });

  await check("until SUPPORT_* is set, support mail keeps the shared mailbox, says so in ONE line, and still answers to support@", async () => {
    setSupport(null);
    oasisRow = { from_address: SHARED, app_password: "row-password" };
    const { result, warn, error } = await logsOf(() => sendOasisSharedGmail(ack));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(last().auth.user, SHARED);
    assert.equal(last().mail.from, SHARED, "no 'OASIS AI Support' display name on another mailbox");
    assert.equal(last().mail.replyTo, SUPPORT, "Reply-To is support@ immediately");
    assert.deepEqual(last().mail.headers, { "List-Unsubscribe": `<mailto:${SUPPORT}?subject=UNSUBSCRIBE>` });
    assert.ok(String(last().mail.text).endsWith(OASIS_SUPPORT_FOOTER));
    const lines = supportLines([...warn, ...error]);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.equal(supportLines(warn).length, 1, "a missing credential is a warning");
    assert.match(lines[0], /support-ack: not sent from support@oasisai\.work \(SUPPORT_GMAIL_USER and SUPPORT_GMAIL_APP_PASSWORD not set\); sending from team@oasisai\.work instead/);
  });

  await check("a support credential for another mailbox is refused, logged as an error, and the shared mailbox sends", async () => {
    setSupport(SHARED);
    oasisRow = { from_address: SHARED, app_password: "row-password" };
    const { result, error } = await logsOf(() => sendOasisSharedGmail(ack));
    assert.equal(result.ok, true);
    assert.equal(last().auth.user, SHARED);
    assert.equal(last().auth.pass, "row-password", "the misconfigured support password is never used");
    const lines = supportLines(error);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /SUPPORT_GMAIL_USER is not support@oasisai\.work/);
    assert.doesNotMatch(lines[0], /abcd/, "the support password never reaches a log line");
  });

  await check("with neither support@ nor the shared mailbox, nothing is sent and the reason names both", async () => {
    setSupport(null);
    oasisRow = {};
    const before = sent.length;
    const { result, warn } = await logsOf(() => sendOasisSharedGmail(ack));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_configured");
      assert.match(result.error, /support@oasisai\.work cannot send \(SUPPORT_GMAIL_USER and SUPPORT_GMAIL_APP_PASSWORD not set\) and no oasis_gmail mailbox is configured/);
      // The desk records "email: FAILED (<reason>: <error>)" cut at 160 characters.
      assert.ok(`${result.reason}: ${result.error}`.length <= 160, "the reason survives the ticket's 160-character outcome");
    }
    assert.equal(sent.length, before);
    assert.match(supportLines(warn)[0] ?? "", /no other mailbox is configured either/);
  });

  await check("sales mail never reads the support credential: shared mailbox, rep Reply-To, outreach footer", async () => {
    setSupport(SUPPORT);
    oasisRow = { from_address: SHARED, app_password: "row-password" };
    const { result, warn, error } = await logsOf(() =>
      sendOasisSharedGmail({ tenantId: OASIS_TENANT, to: "lead@example.test", cc: [REP], subject: "Following up", body: "Hi Simon,\n\nShort note.", idempotencyKey: "lead:1" }),
    );
    assert.equal(result.ok, true);
    assert.equal(last().auth.user, SHARED);
    assert.equal(last().mail.from, SHARED);
    assert.equal(last().mail.replyTo, REP, "a lead's reply reaches the rep, as before");
    assert.deepEqual(last().mail.headers, { "List-Unsubscribe": `<mailto:${SHARED}?subject=UNSUBSCRIBE>` });
    assert.match(String(last().mail.text), /reached out about your business/);
    assert.deepEqual(supportLines([...warn, ...error]), []);
  });

  await check("support Reply-To ignores a caller's replyTo; a teammate who writes still signs", () => {
    const msg = composeOasisMessage({
      to: CLIENT,
      cc: [REP],
      replyTo: REP,
      subject: "Your launch",
      body: "Hi Ana,\n\nIt is live.",
      signer: { name: "Rep" },
      fromAddress: SUPPORT,
      purpose: "support",
    });
    assert.equal(msg.replyTo, SUPPORT);
    assert.equal(msg.cc, REP, "the teammate keeps a copy");
    assert.ok(msg.text.startsWith("Hi Ana,\n\nIt is live.\n\nRep\n\n---\n"), msg.text);
  });

  await check("the support desk sends as support: the client's acknowledgement leaves from support@", async () => {
    setSupport(SUPPORT);
    oasisRow = {};
    const { defaultNotifyDeps } = await import("../lib/delivery/notify");
    const r = await defaultNotifyDeps().email({ to: CLIENT, subject: ack.subject, body: ack.body, idempotencyKey: "support-ack:t2" });
    assert.deepEqual(r, { ok: true });
    assert.equal(last().auth.user, SUPPORT);
    assert.equal(last().mail.to, CLIENT);
    assert.equal(last().mail.replyTo, SUPPORT);
    assert.ok(String(last().mail.text).endsWith(OASIS_SUPPORT_FOOTER));
  });

  await check("the Clients hub resolves support@ first, then the shared mailbox, then nothing; its route sends as support", async () => {
    setSupport(SUPPORT);
    oasisRow = { from_address: SHARED, app_password: "row-password" };
    assert.equal(await resolveOasisSupportMailboxFrom(OASIS_TENANT), SUPPORT);
    setSupport(null);
    assert.equal(await resolveOasisSupportMailboxFrom(OASIS_TENANT), SHARED);
    oasisRow = {};
    assert.equal(await resolveOasisSupportMailboxFrom(OASIS_TENANT), null);
    const route = readFileSync(join(ROOT, "app/api/clients/[id]/reply/route.ts"), "utf8");
    assert.match(route, /oasisMailboxFrom: resolveOasisSupportMailboxFrom,/);
    assert.match(route, /sendOasisSharedGmail\(\{[\s\S]*?purpose: "support",[\s\S]*?\}\)/);
  });

  // The deployed Worker configures the shared mailbox through OASIS_MAIL_FROM /
  // OASIS_MAIL_APP_PASSWORD, not the tenant row, so this is the precedence that
  // decides what clients see. Both copies of it are pinned: the sender's and
  // the Clients hub's resolver.
  await check("support@ outranks the OASIS_MAIL env pair in the sender and the Clients-hub resolver; sales keeps the pair", async () => {
    const before = { from: process.env.OASIS_MAIL_FROM, pass: process.env.OASIS_MAIL_APP_PASSWORD };
    try {
      process.env.OASIS_MAIL_FROM = SHARED;
      process.env.OASIS_MAIL_APP_PASSWORD = "env-pair-password";
      setSupport(SUPPORT);
      oasisRow = {};
      const support = await sendOasisSharedGmail({ ...ack, idempotencyKey: "support-ack:env-pair" });
      assert.equal(support.ok, true, JSON.stringify(support));
      assert.equal(last().auth.user, SUPPORT, "support mail logs in as support@ although the env pair is set");
      assert.equal(last().mail.from, `"OASIS AI Support" <${SUPPORT}>`);
      assert.equal(await resolveOasisSupportMailboxFrom(OASIS_TENANT), SUPPORT, "the Clients hub names support@ too");
      const sales = await sendOasisSharedGmail({
        tenantId: OASIS_TENANT,
        to: "lead@example.test",
        subject: "Following up",
        body: "Hi Simon,\n\nShort note.",
        idempotencyKey: "lead:env-pair",
      });
      assert.equal(sales.ok, true, JSON.stringify(sales));
      assert.equal(last().auth.user, SHARED, "sales mail keeps the OASIS_MAIL pair");
    } finally {
      if (before.from === undefined) delete process.env.OASIS_MAIL_FROM;
      else process.env.OASIS_MAIL_FROM = before.from;
      if (before.pass === undefined) delete process.env.OASIS_MAIL_APP_PASSWORD;
      else process.env.OASIS_MAIL_APP_PASSWORD = before.pass;
    }
  });

  await check("the support footer is OASIS's only: another brand's email refuses it, OASIS mail closes with it", () => {
    assert.throws(
      () => appendSignatureAndFooter("Hi Ana,\n\nDone.", { brand: "sunbiz", purpose: "support" }),
      /support mail is OASIS's/,
    );
    const oasis = appendSignatureAndFooter("Hi Ana,\n\nDone.", { brand: "oasis", purpose: "support" });
    assert.ok(oasis.endsWith(OASIS_SUPPORT_FOOTER), oasis);
  });

  await check("an approved email to a CLIENT goes as support mail; one to a lead stays sales mail", async () => {
    const { EXECUTORS, defaultExecutorDeps, emailPurposeFor } = await import("../lib/os/approvals/executors");
    assert.equal(emailPurposeFor({ target_ref: "customer:c1" }), "support");
    assert.equal(emailPurposeFor({ target_ref: "lead:l1" }), "sales");
    assert.equal(emailPurposeFor({ target_ref: null }), "sales");
    setSupport(SUPPORT);
    oasisRow = { from_address: SHARED, app_password: "row-password" };
    const deps = { ...defaultExecutorDeps(), isDryRun: () => false };
    const run = (targetRef: string, key: string) =>
      EXECUTORS.send_email!.run({
        db: {} as never,
        approval: { target_ref: targetRef, idempotency_key: key } as never,
        payload: { to: CLIENT, subject: "Your launch", body: "Hello." },
        tenant: { id: OASIS_TENANT, slug: "oasis-ai-cc" },
        approver: { userId: "u1", email: REP },
        deps,
      });
    const client = await run("customer:c1", "client-email:c1:d1");
    assert.equal(client.ok, true, JSON.stringify(client.result));
    assert.equal(last().auth.user, SUPPORT);
    assert.equal(last().mail.replyTo, SUPPORT);
    assert.ok(String(last().mail.text).endsWith(OASIS_SUPPORT_FOOTER));
    const lead = await run("lead:l1", "agent:x:2026-10-01:new:h1");
    assert.equal(lead.ok, true, JSON.stringify(lead.result));
    assert.equal(last().auth.user, SHARED);
    assert.equal(last().mail.replyTo, REP);
  });

  await check("invoices: an explicit INVOICE_FROM wins, then support@, then the shared mailbox (logged); replies go to support@", async () => {
    const { resolveInvoiceMailbox, sendInvoiceEmail } = await import("../lib/founders-finances/invoice-email");
    const invoice = { tenantId: null, to: CLIENT, subject: "Invoice OASIS-2026-0001", text: "t", html: "<p>t</p>", pdf: new Uint8Array([37, 80, 68, 70]), filename: "OASIS-2026-0001.pdf" };
    process.env.OASIS_MAIL_FROM = SHARED;
    process.env.OASIS_MAIL_APP_PASSWORD = "shared-password";

    setSupport(SUPPORT);
    const viaSupport = await resolveInvoiceMailbox(null);
    assert.deepEqual([viaSupport.source, viaSupport.from, viaSupport.name], ["support_env", SUPPORT, "OASIS AI Solutions"]);
    const s1 = await logsOf(() => sendInvoiceEmail(invoice));
    assert.equal(last().auth.user, SUPPORT);
    assert.equal(last().mail.from, `"OASIS AI Solutions" <${SUPPORT}>`);
    assert.equal(last().mail.replyTo, SUPPORT);
    assert.deepEqual(supportLines([...s1.warn, ...s1.error]), []);

    process.env.INVOICE_FROM_EMAIL = "billing@oasisai.work";
    process.env.INVOICE_FROM_APP_PASSWORD = "billing-password";
    assert.equal((await resolveInvoiceMailbox(null)).source, "invoice_env", "an explicit invoice mailbox is a deliberate choice");
    delete process.env.INVOICE_FROM_EMAIL;
    delete process.env.INVOICE_FROM_APP_PASSWORD;

    setSupport(null);
    assert.equal((await resolveInvoiceMailbox(null)).source, "oasis_env");
    const s2 = await logsOf(() => sendInvoiceEmail(invoice));
    assert.equal(last().auth.user, SHARED);
    assert.equal(last().mail.replyTo, SUPPORT, "Reply-To is support@ immediately");
    const lines = supportLines(s2.warn);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /^\[support-mail\] invoice: not sent from support@oasisai\.work/);
    delete process.env.OASIS_MAIL_FROM;
    delete process.env.OASIS_MAIL_APP_PASSWORD;
  });

  await check("account-security mail: dedicated AUTH_* wins, then support@, then GMAIL_USER (logged); replies go to support@", async () => {
    const { resolveAuthEmailConfig, sendAuthEmail } = await import("../lib/auth-email");
    const supportEnv = { SUPPORT_GMAIL_USER: SUPPORT, SUPPORT_GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop", GMAIL_USER: SHARED, GMAIL_APP_PASSWORD: "x" };
    const viaSupport = resolveAuthEmailConfig(supportEnv);
    assert.equal(viaSupport.ok, true);
    if (viaSupport.ok) {
      const c = viaSupport.config;
      assert.deepEqual([c.source, c.host, c.port, c.secure, c.user, c.fromEmail, c.password], ["support", "smtp.gmail.com", 465, true, SUPPORT, SUPPORT, "abcdefghijklmnop"]);
    }
    const dedicated = resolveAuthEmailConfig({
      ...supportEnv,
      AUTH_SMTP_HOST: "smtp.transactional.example",
      AUTH_SMTP_PORT: "587",
      AUTH_SMTP_USER: "account-security-service",
      AUTH_SMTP_PASSWORD: "p",
      AUTH_FROM_EMAIL: "security@oasisai.work",
    });
    assert.equal(dedicated.ok && dedicated.config.source, "dedicated");

    const envelopes: Array<Record<string, unknown>> = [];
    const transport = {
      async sendMail(input: Record<string, unknown>) {
        envelopes.push(input);
        return { accepted: ["owner@client.test"], rejected: [] };
      },
    };
    const mail = { to: "owner@client.test", subject: "You are invited", text: "fixture" };
    const viaSupportSend = await logsOf(() => sendAuthEmail(mail, { env: supportEnv, transport }));
    assert.deepEqual(viaSupportSend.result, { ok: true });
    assert.deepEqual(envelopes[0].from, { name: "OASIS AI Account Security", address: SUPPORT });
    assert.equal(envelopes[0].replyTo, SUPPORT);
    assert.deepEqual(supportLines([...viaSupportSend.warn, ...viaSupportSend.error]), []);

    const fallback = await logsOf(() => sendAuthEmail(mail, { env: { GMAIL_USER: SHARED, GMAIL_APP_PASSWORD: "x" }, transport }));
    assert.deepEqual(fallback.result, { ok: true });
    assert.deepEqual(envelopes[1].from, { name: "OASIS AI Account Security", address: SHARED });
    assert.equal(envelopes[1].replyTo, SUPPORT, "Reply-To is support@ immediately");
    const lines = supportLines(fallback.warn);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /^\[support-mail\] auth-email: not sent from support@oasisai\.work .* sending from team@oasisai\.work instead/);

    const wrong = await logsOf(() =>
      sendAuthEmail(mail, { env: { SUPPORT_GMAIL_USER: REP, SUPPORT_GMAIL_APP_PASSWORD: "y", GMAIL_USER: SHARED, GMAIL_APP_PASSWORD: "x" }, transport }),
    );
    assert.deepEqual((envelopes[2].from as { address: string }).address, SHARED, "another mailbox's support credential is refused");
    assert.equal(supportLines(wrong.error).length, 1);
  });

  if (failures > 0) {
    console.error(`support-sender: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("support-sender: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
