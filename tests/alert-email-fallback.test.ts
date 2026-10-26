/**
 * tests/alert-email-fallback.test.ts - an OASIS alert Telegram refuses reaches
 * CC by email (lib/notify/alert-route.ts, 2026-10-26).
 *
 * OASIS's bot token was revoked and every booking and AI-audit alert died as
 * "Telegram said: Unauthorized", so CC missed the calls people booked. Pins:
 *
 *   1. Telegram refuses -> one email to CC's own address, the alert as plain
 *      text, and the card's outcome says both: what Telegram said and that it
 *      was emailed instead. delivered = true: a person was reached.
 *   2. Telegram delivers -> no email.
 *   3. The same alert in the same hour is one idempotency key (one Message-ID,
 *      so one email); a different alert, or the next hour, is a new one.
 *   4. Telegram refuses and the email fails too -> delivered = false and the
 *      outcome says both failed, so callers still record the failure.
 *   5. BRAVO_FORCE_DRY_RUN=1 -> no email.
 *   6. Only OASIS's own lane falls back: the fallback sits inside the
 *      oasis_operator branch, before any workspace bot.
 *   7. The shared mailbox lets an internal alert use the Worker's Gmail login
 *      when nothing else is configured, and its brand guard still refuses a
 *      mailbox outside oasisai.work. Nothing here reaches the network.
 *
 * Independent review of #738 (2026-10-26):
 *   8. At most ten emails an hour per lane. The eleventh alert is one notice
 *      that carries it and says where the rest are; every later one that hour
 *      is not emailed (delivered = false, so its caller records it in the app).
 *      A held alert gives its place back; a failed send keeps it.
 *   9. Never throws, even when the sender or the cap throws.
 *  10. Every refusal is logged, even when the email reaches CC: an outage the
 *      email covers is still an outage.
 * The cap is an in-memory stand-in for claimCappedSlot here (the real one
 * counts in pair_attempts and is pinned by its own tests).
 *
 * Run: node --conditions=react-server --import tsx tests/alert-email-fallback.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CC = "conaugh@oasisai.work";

process.env.OASIS_TELEGRAM_BOT_TOKEN = "cc-token";
process.env.OASIS_TELEGRAM_CHAT_ID = "555000";
delete process.env.BRAVO_FORCE_DRY_RUN;
for (const k of ["OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD", "SUPPORT_GMAIL_USER", "SUPPORT_GMAIL_APP_PASSWORD", "GMAIL_USER", "GMAIL_APP_PASSWORD"]) delete process.env[k];

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

/** Telegram answers every send with `status` (200 = delivered). */
function stubTelegram(status: number, description = "Unauthorized"): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    status === 200
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response(JSON.stringify({ ok: false, description }), { status })) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

type Mail = { tenantId: string; to: string; subject: string; body: string; idempotencyKey: string };

/** claimCappedSlot in memory: every claim takes a place until it is released. */
function slotStore() {
  const live = new Map<string, number>();
  const slot = async (key: string, _windowSeconds: number, cap: number) => {
    const n = (live.get(key) ?? 0) + 1;
    live.set(key, n);
    let released = false;
    return {
      allowed: n <= cap,
      release: async () => {
        if (released) return;
        released = true;
        live.set(key, (live.get(key) ?? 1) - 1);
      },
    };
  };
  return { slot, live };
}
/** A cap that always has room. */
const open = async () => ({ allowed: true, release: async () => undefined });

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = console.error;
  const warn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = err;
    console.warn = warn;
  }
}

async function main() {
  console.log("alert email fallback:");
  const { pushWorkspaceAlert, alertPlainText, founderAlertMessage, ALERT_EMAILS_PER_LANE_PER_HOUR } = await import("../lib/notify/alert-route");
  const at = new Date("2026-10-26T18:20:00.000Z");
  const ALERT = '📅 <b>Dana Lead</b> booked an AI audit &amp; paid\n<a href="https://oasisai.work/pipeline/1?x=1&amp;y=2">Open the lead</a>';

  await check("Telegram refuses: one email to CC, plain text, and the outcome says both what Telegram said and that it was emailed", async () => {
    const sent: Mail[] = [];
    const restore = stubTelegram(401);
    const r = await quietly(() => pushWorkspaceAlert(OASIS, ALERT, { desk: "sales", now: at, slot: open, email: async (m) => (sent.push(m), { ok: true }) }));
    restore();
    assert.equal(r.delivered, true, r.outcome);
    assert.equal(r.outcome, `Not sent: Telegram said: Unauthorized. Emailed to ${CC} instead`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, CC, "only CC's own address");
    assert.equal(sent[0].tenantId, OASIS);
    assert.equal(sent[0].subject, "OASIS alert: 📅 Dana Lead booked an AI audit & paid");
    assert.match(sent[0].body, /^📅 Dana Lead booked an AI audit & paid\nOpen the lead \(https:\/\/oasisai\.work\/pipeline\/1\?x=1&y=2\)\n\n/);
    assert.match(sent[0].body, /This came by email because Telegram refused it \(Telegram said: Unauthorized\)\./);
    assert.doesNotMatch(sent[0].body, /<|&amp;|cc-token/, "no tags, no entities, never the token");
    assert.match(sent[0].idempotencyKey, /^alert-email:sales:[0-9a-f]{16}:2026-10-26T18$/);
  });

  await check("Telegram delivers: no email", async () => {
    let called = 0;
    const restore = stubTelegram(200);
    const r = await pushWorkspaceAlert(OASIS, ALERT, { desk: "sales", now: at, slot: open, email: async () => (called++, { ok: true }) });
    restore();
    assert.deepEqual(r, { delivered: true, outcome: "Sent to Telegram" });
    assert.equal(called, 0);
  });

  await check("the same alert in the same hour is one key; another alert or the next hour is a new one", () => {
    const a = founderAlertMessage(ALERT, "sales", "Not sent: Telegram said: Unauthorized", at);
    const again = founderAlertMessage(ALERT, "sales", "Not sent: Telegram said: Unauthorized", new Date("2026-10-26T18:59:59.000Z"));
    const other = founderAlertMessage(`${ALERT} (2)`, "sales", "Not sent: Telegram said: Unauthorized", at);
    const later = founderAlertMessage(ALERT, "sales", "Not sent: Telegram said: Unauthorized", new Date("2026-10-26T19:00:00.000Z"));
    const operator = founderAlertMessage(ALERT, "operator", "Not sent: Telegram said: Unauthorized", at);
    assert.equal(again.idempotencyKey, a.idempotencyKey, "a retry or a repeat within the hour is one Message-ID");
    assert.notEqual(other.idempotencyKey, a.idempotencyKey);
    assert.notEqual(later.idempotencyKey, a.idempotencyKey);
    assert.notEqual(operator.idempotencyKey, a.idempotencyKey);
  });

  await check("Telegram refuses and the email fails too: not delivered, and the outcome says both", async () => {
    const restore = stubTelegram(401);
    const r = await quietly(() =>
      pushWorkspaceAlert(OASIS, ALERT, { desk: "sales", now: at, slot: open, email: async () => ({ ok: false, error: "not_configured: no mailbox" }) }),
    );
    const thrown = await quietly(() =>
      pushWorkspaceAlert(OASIS, ALERT, { now: at, slot: open, email: async () => { throw new Error("smtp down"); } }),
    );
    restore();
    assert.equal(r.delivered, false);
    assert.equal(r.outcome, "Not sent: Telegram said: Unauthorized. The email fallback failed too (not_configured: no mailbox)");
    assert.equal(thrown.delivered, false, "a sender that throws is a failure, never an exception out of here");
    assert.match(thrown.outcome, /The email fallback failed too \(smtp down\)$/);
  });

  await check("BRAVO_FORCE_DRY_RUN=1: no email", async () => {
    process.env.BRAVO_FORCE_DRY_RUN = "1";
    let called = 0;
    const restore = stubTelegram(401);
    const r = await quietly(() => pushWorkspaceAlert(OASIS, ALERT, { now: at, slot: open, email: async () => (called++, { ok: true }) }));
    restore();
    delete process.env.BRAVO_FORCE_DRY_RUN;
    assert.equal(called, 0);
    assert.equal(r.delivered, false);
    assert.match(r.outcome, /^Not sent: Telegram said: Unauthorized\. Not emailed either: sending is switched off \(dry run\)$/);
  });

  await check("only OASIS's own lane falls back: the email sits inside the oasis_operator branch, before any workspace bot", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "notify", "alert-route.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function pushWorkspaceAlert("));
    const operatorBranch = body.indexOf('audience === "oasis_operator"');
    const fallback = body.indexOf("emailFounderInstead(tenantId");
    const workspaceBot = body.indexOf("sendWorkspaceTelegram(tenantId");
    assert.ok(operatorBranch > -1 && fallback > operatorBranch && fallback < workspaceBot, "a client workspace's alert is never emailed to OASIS");
    const helper = src.slice(src.indexOf("async function emailFounderInstead("), src.indexOf("export async function pushWorkspaceAlert("));
    assert.match(helper, /\(opts\.email \?\? sendFounderAlertEmail\)\(/, "the founder's mailbox is reached from the fallback");
    assert.equal(src.split("sendFounderAlertEmail)(").length, 2, "and from nowhere else");
    assert.equal(alertPlainText("<i>a</i> &lt;b&gt; &amp;lt;"), "a <b> &lt;", "entities decode once");
    assert.equal(alertPlainText('<a href="https://x.test/">https://x.test/</a>'), "https://x.test/");
  });

  await check("at most ten an hour per lane: the eleventh is one notice that carries it, every later one stays in the app", async () => {
    const store = slotStore();
    const sent: Mail[] = [];
    const email = async (m: Mail) => (sent.push(m), { ok: true });
    const restore = stubTelegram(401);
    const sales = await quietly(async () => {
      const out = [];
      for (let i = 1; i <= 13; i += 1) out.push(await pushWorkspaceAlert(OASIS, `${ALERT} #${i}`, { desk: "sales", now: at, slot: store.slot, email }));
      return out;
    });
    const operator = await quietly(() => pushWorkspaceAlert(OASIS, "Cron failed", { now: at, slot: store.slot, email }));
    restore();
    assert.equal(ALERT_EMAILS_PER_LANE_PER_HOUR, 10);
    assert.deepEqual(sales.slice(0, 11).map((r) => r.outcome), Array(11).fill(`Not sent: Telegram said: Unauthorized. Emailed to ${CC} instead`), "ten alerts, then the notice that carries the eleventh");
    assert.equal(sent.slice(0, 10).filter((m) => m.subject === "OASIS alert: 📅 Dana Lead booked an AI audit & paid").length, 10);
    const notice = sent[10];
    assert.equal(notice.to, CC);
    assert.equal(notice.subject, "OASIS alerts: more than 10 in an hour, the rest are in the app");
    assert.match(notice.body, /^More OASIS alerts arrived on the sales lane in the last hour than email carries \(10 an hour\)\. /);
    assert.match(notice.body, /a lead's alert on that lead's timeline, an agent's under Needs you on Today\./);
    assert.match(notice.body, /The alert that crossed the line:\n\n📅 Dana Lead booked an AI audit & paid\nOpen the lead \(https:\/\/oasisai\.work\/pipeline\/1\?x=1&y=2\) #11\n\n/);
    assert.match(notice.body, /This came by email because Telegram refused it \(Telegram said: Unauthorized\)\./);
    assert.equal(notice.idempotencyKey, "alert-email-held:sales:2026-10-26T18");
    for (const r of sales.slice(11)) {
      assert.deepEqual(r, {
        delivered: false,
        outcome: "Not sent: Telegram said: Unauthorized. Not emailed: 10 alert emails already went out in the last hour, so this one is only in the app",
      }, "not delivered, so its caller records it in the app");
    }
    assert.equal(operator.delivered, true, "each lane has its own ten");
    assert.equal(sent.length, 12, "ten, the notice, and the operator lane's own");
    assert.equal(store.live.get("alert-email:sales"), 10, "a held alert gives its place back: the cap counts the emails that went");
    assert.equal(store.live.get("alert-email-held:sales"), 1, "one notice");
    assert.equal(store.live.get("alert-email:operator"), 1);
  });

  await check("a failed send keeps its place, so a broken mailbox is tried at most ten times and one notice an hour", async () => {
    const store = slotStore();
    let tried = 0;
    const restore = stubTelegram(401);
    const results = await quietly(async () => {
      const out = [];
      for (let i = 1; i <= 14; i += 1) out.push(await pushWorkspaceAlert(OASIS, `${ALERT} #${i}`, { desk: "sales", now: at, slot: store.slot, email: async () => (tried++, { ok: false, error: "auth: 535" }) }));
      return out;
    });
    restore();
    assert.equal(tried, 11);
    assert.ok(results.slice(0, 11).every((r) => !r.delivered && r.outcome.endsWith("The email fallback failed too (auth: 535)")));
    assert.ok(results.slice(11).every((r) => !r.delivered && / Not emailed: 10 alert emails already went out in the last hour, so this one is only in the app$/.test(r.outcome)));
  });

  await check("never throws: a sender or a cap that throws is a failed email, not an exception", async () => {
    const restore = stubTelegram(401);
    const syncThrow = await quietly(() =>
      pushWorkspaceAlert(OASIS, ALERT, { now: at, slot: open, email: () => { throw new Error("sync boom"); } }),
    );
    const capThrows = await quietly(() =>
      pushWorkspaceAlert(OASIS, ALERT, { now: at, slot: async () => { throw new Error("db down"); }, email: async () => ({ ok: true }) }),
    );
    restore();
    assert.deepEqual(syncThrow, { delivered: false, outcome: "Not sent: Telegram said: Unauthorized. The email fallback failed too (sync boom)" });
    assert.deepEqual(capThrows, { delivered: false, outcome: "Not sent: Telegram said: Unauthorized. The email fallback failed too (db down)" });
  });

  await check("every refusal is logged, even when the email reaches CC, and never with the bot token", async () => {
    const warned: unknown[][] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    const restore = stubTelegram(401);
    try {
      const r = await pushWorkspaceAlert(OASIS, ALERT, { desk: "sales", now: at, slot: open, email: async () => ({ ok: true }) });
      assert.equal(r.delivered, true);
      await pushWorkspaceAlert(OASIS, ALERT, { now: at, slot: open, email: async () => ({ ok: true }) });
    } finally {
      restore();
      console.warn = real;
    }
    assert.equal(warned.length, 2, "one line per refusal");
    assert.match(String(warned[0][0]), /OASIS's Telegram lane refused an alert/);
    assert.deepEqual(warned[0][1], { tenantId: OASIS, lane: "sales", telegram: "Not sent: Telegram said: Unauthorized" });
    assert.deepEqual(warned[1][1], { tenantId: OASIS, lane: "operator", telegram: "Not sent: Telegram said: Unauthorized" });
    assert.doesNotMatch(JSON.stringify(warned), /cc-token/);
  });

  await check("the shared mailbox: an internal alert falls back to the Worker's Gmail login, and the brand guard still refuses a mailbox outside oasisai.work", async () => {
    const { sendOasisSharedGmail } = await import("../lib/integrations/oasis-shared-gmail-send");
    const alert = { tenantId: OASIS, to: CC, subject: "OASIS alert: x", body: "x", idempotencyKey: "alert-email:sales:00000000:2026-10-26T18", purpose: "support" as const, internalAlert: true };
    const none = await quietly(() => sendOasisSharedGmail(alert));
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.reason, "not_configured", "control: no mailbox anywhere");
    process.env.GMAIL_USER = "someone@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    try {
      const wrongBrand = await quietly(() => sendOasisSharedGmail(alert));
      assert.equal(wrongBrand.ok, false);
      if (!wrongBrand.ok) {
        assert.equal(wrongBrand.reason, "brand_mismatch", "the Gmail login was used, and the guard refused a non-OASIS mailbox before any SMTP");
        assert.doesNotMatch(wrongBrand.error, /abcd|efgh/, "never the password");
      }
    } finally {
      delete process.env.GMAIL_USER;
      delete process.env.GMAIL_APP_PASSWORD;
    }
    const src = readFileSync(join(__dirname, "..", "lib", "integrations", "oasis-shared-gmail-send.ts"), "utf8");
    assert.match(src, /if \(\(!fromAddress \|\| !appPassword\) && isInternalTeamAlert\(args\)\) \{\s*const gwsFrom = \(process\.env\.GMAIL_USER/, "the Gmail login is read only for an internal team alert");
  });

  console.log(failures ? `alert email fallback: ${failures} failure(s)` : "alert email fallback: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
