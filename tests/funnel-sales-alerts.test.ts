/**
 * tests/funnel-sales-alerts.test.ts - a new lead reaches the sales desk, and the
 * desk can never be silenced by a missing group.
 *
 * Until 2026-10-15 every funnel alert went to CC's DM, so Adon, who splits the
 * leads with him, never saw one. The "sales" lane sends to a group both read
 * (OASIS_SALES_TELEGRAM_CHAT_ID). These pin what makes that safe:
 *
 *   1. with the group id UNSET the lane still delivers, to CC's chat, exactly as
 *      before: deploying the code can never lose an alert;
 *   2. the operator lane is untouched even once the group is configured;
 *   3. a group the bot was removed from falls back to CC's DM in the SAME lane,
 *      says what to fix, and still counts as delivered;
 *   4. the booked-call alert escapes and caps everything a stranger typed, shows
 *      Toronto time, and only links a real Google Meet URL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const GROUP = "-100777000";
const CC_DM = "555000";

process.env.OASIS_TELEGRAM_BOT_TOKEN = "cc-token";
process.env.OASIS_TELEGRAM_CHAT_ID = CC_DM;
delete process.env.OASIS_SALES_TELEGRAM_CHAT_ID;
delete process.env.OASIS_SALES_TELEGRAM_BOT_TOKEN;

type Sent = { chatId: string; token: string; text: string };

function stubFetch(failing: Set<string>): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const token = String(url).match(/\/bot([^/]+)\//)?.[1] ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string };
    const chatId = String(body.chat_id ?? "");
    sent.push({ chatId, token, text: String(body.text ?? "") });
    if (failing.has(chatId)) {
      return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was kicked from the group chat" }), {
        status: 403,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function main(): Promise<void> {
  const { pushWorkspaceAlert } = await import("../lib/notify/alert-route");

  // 1. Group id unset: the sales lane delivers to CC's chat, as before.
  {
    const { sent, restore } = stubFetch(new Set());
    const r = await pushWorkspaceAlert(OASIS, "new lead", { desk: "sales" });
    restore();
    assert.equal(r.delivered, true, r.outcome);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, CC_DM, "with no group configured the alert must still reach CC");
    assert.equal(sent[0].token, "cc-token");
  }
  console.log("  ok - sales lane with no group id still reaches CC's chat");

  // 2. Group configured: sales goes to the group, the operator lane does not move.
  process.env.OASIS_SALES_TELEGRAM_CHAT_ID = GROUP;
  {
    const { sent, restore } = stubFetch(new Set());
    const sales = await pushWorkspaceAlert(OASIS, "new lead", { desk: "sales" });
    const operator = await pushWorkspaceAlert(OASIS, "cron failed");
    restore();
    assert.equal(sales.delivered && operator.delivered, true);
    assert.deepEqual(sent.map((s) => s.chatId), [GROUP, CC_DM], "sales -> group, operator -> CC, never swapped");
  }
  console.log("  ok - sales goes to the group; the operator lane is untouched");

  // 3. Bot removed from the group: same-lane fallback to CC's DM, with the fix named.
  {
    const { sent, restore } = stubFetch(new Set([GROUP]));
    const r = await pushWorkspaceAlert(OASIS, "Dana Lead booked", { desk: "sales" });
    restore();
    assert.equal(r.delivered, true, "a human was reached, so the lead alert is delivered");
    assert.match(r.outcome, /backup/i, "...and the outcome says the main chat refused it");
    assert.deepEqual(sent.map((s) => s.chatId), [GROUP, CC_DM]);
    assert.match(sent[1].text, /Dana Lead booked/, "the alert survives the wrapper");
    assert.match(sent[1].text, /sales group needs the bot re-added/, "it names the sales group, not the ops group");
  }
  console.log("  ok - a removed bot falls back to CC's DM and says what to fix");

  // 4. Everything down: an honest failure, so the funnel records a marker.
  {
    const { restore } = stubFetch(new Set([GROUP, CC_DM]));
    const r = await pushWorkspaceAlert(OASIS, "x", { desk: "sales" });
    restore();
    assert.equal(r.delivered, false);
    assert.match(r.outcome, /^Not sent/);
  }
  console.log("  ok - when nothing is reachable the alert reports not delivered");

  // 5. Only OASIS's own workspaces have a sales desk. The branch that picks the
  //    lane sits inside the oasis_operator audience, before any workspace bot.
  {
    const src = readFileSync(join(__dirname, "..", "lib", "notify", "alert-route.ts"), "utf8");
    const operatorBranch = src.indexOf('audience === "oasis_operator"');
    const deskPick = src.indexOf('opts?.desk === "sales"');
    const workspaceBot = src.indexOf("sendWorkspaceTelegram(tenantId");
    assert.ok(operatorBranch > -1 && deskPick > operatorBranch && deskPick < workspaceBot,
      "a client workspace must never be able to pick the sales lane");
  }
  console.log("  ok - a client workspace cannot choose the sales lane");

  // 6. The funnel notifiers name no lane: the audience comes from the workspace.
  for (const file of ["lib/forms/ai-audit-notify.ts", "lib/forms/oasis-funnel-notify.ts", "app/api/forms/booking/route.ts"]) {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(src, /\blane\s*:/, `${file} names a Telegram lane again`);
    assert.match(src, /desk:\s*"sales"/, `${file} does not address the sales desk`);
  }
  console.log("  ok - every funnel alert addresses the sales desk through the resolver");

  // 7. The booked-call alert.
  const { buildBookedLeadAlert, formatBookedTime } = await import("../lib/forms/public-booking-alert");
  const alert = buildBookedLeadAlert({
    offerName: "AI automation audit",
    name: "Dana <b>Lead</b>",
    company: "Dana & Co",
    revenue: "$30K-$75K a month",
    bottleneck: "x".repeat(900),
    startsAt: "2026-10-16T18:30:00.000Z",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    leadUrl: "https://oasisai.work/pipeline/L1",
  });
  assert.match(alert, /Dana &lt;b&gt;Lead&lt;\/b&gt;/, "visitor-typed HTML is escaped");
  assert.match(alert, /Dana &amp; Co/);
  assert.ok(!/x{301}/.test(alert), "a long bottleneck is capped");
  assert.match(alert, /Call: .*2:30.*EDT/, "shown in Toronto time, not UTC");
  assert.match(alert, /href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
  assert.match(alert, /href="https:\/\/oasisai\.work\/pipeline\/L1"/);
  assert.match(formatBookedTime("2026-12-16T19:30:00.000Z"), /EST/, "winter time is EST");

  const hostile = buildBookedLeadAlert({
    offerName: "x", name: "", company: "", revenue: "", bottleneck: "",
    startsAt: "not a date", meetUrl: 'https://evil.example/"><script>', leadUrl: "https://oasisai.work/pipeline/L2",
  });
  assert.ok(!hostile.includes('href="https://evil'), "only a real Google Meet URL becomes a link");
  assert.match(hostile, /New lead/);
  assert.match(hostile, /Revenue: not provided/);
  assert.match(hostile, /Bottleneck: not provided/);
  assert.match(hostile, /Call: not a date/, "an unparseable time is shown as given, never thrown");
  console.log("  ok - the booked-call alert escapes, caps, shows Toronto time, links only Meet");

  // 8. The completed-lead alert says unbooked and links the lead.
  const { buildAiAuditAlert } = await import("../lib/forms/ai-audit-format");
  const { scoreAiAuditLead } = await import("../lib/forms/ai-audit-ingest");
  const a = { name: "Dana", email: "d@x.test", company: "Dana Co", monthly_revenue: "30_75k", bottleneck_detail: "leads go cold" };
  const msg = buildAiAuditAlert(a, scoreAiAuditLead(a), { leadUrl: "https://oasisai.work/pipeline/L3" });
  assert.match(msg, /unbooked - needs follow-up/);
  assert.match(msg, /pipeline\/L3/);
  console.log("  ok - the completed-lead alert says unbooked and links the lead");

  console.log("funnel-sales-alerts: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
