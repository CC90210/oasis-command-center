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

  // 9. The Sales tab's inbound tile: honest in every state.
  const { inboundTiles, INBOUND_QUEUE_HREF } = await import("../components/os/department/inbound-rules");
  assert.deepEqual(inboundTiles(null), [], "a viewer with no warm-inbound scope gets no tile");
  const failedTile = inboundTiles({ ok: false })[0];
  assert.equal(failedTile.status, "error", "a failed read says so instead of showing 0");
  const emptyTile = inboundTiles({ ok: true, value: { total: 0, untouched: 0, booked: 0 } })[0];
  assert.equal(emptyTile.status, "no_data", "no leads is 'None yet', not a live 0");
  const liveTile = inboundTiles({ ok: true, value: { total: 1234, untouched: 20, booked: 7 } })[0];
  assert.equal(liveTile.status, "live");
  assert.equal(liveTile.value, "1,234");
  assert.equal(liveTile.hint, "20 untouched · 7 booked");
  assert.equal(liveTile.action?.href, INBOUND_QUEUE_HREF);
  assert.equal(INBOUND_QUEUE_HREF, "/pipeline?motion=inbound");
  console.log("  ok - the Sales inbound tile is honest when empty, failed and live");

  // 9b. The Sales tab lists the new inbound leads by name in "Needs you".
  const { inboundWaiting, inboundAttention, inboundLeadLine } = await import("../components/os/department/inbound-rules");
  const NOW = Date.parse("2026-10-20T15:00:00.000Z");
  const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const inboundRow = (id: string, ageDays: number, data: Record<string, unknown>) => ({ id, created_at: day(ageDays), data: { stage: "researched", ...data } });
  const rows = [
    inboundRow("a", 1, { name: "Ada Lovelace", company_name: "Acme", monthly_revenue: "10k_50k", funnel_stage: "audit_requested", primary_bottleneck: "Leads wait days" }),
    inboundRow("b", 0.2, { name: "Bo Chen", company: "Bo Co", funnel_stage: "inbound_lead" }),
    inboundRow("booked", 2, { name: "Already Booked", funnel_stage: "meeting_booked" }),
    inboundRow("old", 15, { name: "Too Old", funnel_stage: "audit_requested" }),
    { id: "worked", created_at: day(1), data: { stage: "attempting_contact", name: "Being Worked" } },
    ...Array.from({ length: 5 }, (_, i) => inboundRow(`x${i}`, 3 + i * 0.1, { name: `Filler ${i}`, funnel_stage: "audit_requested" })),
  ];
  assert.equal(inboundWaiting(rows, NOW, 9).truncated, false, "the stage count matches the rows read: nothing missing");
  const waiting = inboundWaiting(rows, NOW, 12);
  assert.equal(waiting.total, 7, "researched, not booked, inside 14 days: a, b and five fillers");
  assert.deepEqual(waiting.leads.map((l) => l.id).slice(0, 2), ["b", "a"], "newest first");
  assert.equal(waiting.leads.length, 5, "five named, the rest one line");
  assert.equal(waiting.truncated, true, "12 researched exist, the window held 9: the total is a floor");
  assert.equal(
    inboundLeadLine(rows[0].data),
    "Ada Lovelace · Acme · $10-50K/mo · Leads wait days · audit done, unbooked - needs follow-up",
    "words, not option keys, and what the lead did",
  );
  assert.equal(inboundLeadLine(rows[1].data), "Bo Chen · Bo Co · started the form, did not finish");
  const items = inboundAttention({ ok: true, value: { total: 9, untouched: 9, booked: 1, waiting } });
  assert.equal(items.length, 6, "five leads and one 'more' line");
  assert.equal(items[0].href, "/pipeline/b");
  assert.ok(items.every((i) => !/[_]\d|10k_50k|sales_leadgen/.test(i.label)), "no raw option keys on screen");
  assert.equal(items.reduce((s, i) => s + i.count, 0), 7, "the header's Needs you counts each waiting lead once");
  assert.equal(items[5].capped, true, "a truncated window makes the sum a floor");
  assert.match(items[5].label, /^2 new inbound leads waiting in Warm inbound$/);
  assert.deepEqual(inboundAttention(null), []);
  assert.deepEqual(inboundAttention({ ok: false }), []);
  assert.deepEqual(inboundAttention({ ok: true, value: { total: 3, untouched: 0, booked: 0 } }), [], "no list where it was not read");
  assert.deepEqual(inboundAttention({ ok: true, value: { total: 0, untouched: 0, booked: 0, waiting: inboundWaiting([], NOW, 0) } }), []);
  console.log("  ok - the Sales tab names the new inbound leads waiting for a person");

  // 10. The lead page reads stored answers as labels, never raw option keys.
  const { auditAnswerLabel } = await import("../lib/forms/ai-audit-format");
  assert.equal(auditAnswerLabel("revenue", "10k_50k"), "$10-50K/mo");
  assert.equal(auditAnswerLabel("budget", "2k_5k"), "$2-5K");
  assert.equal(auditAnswerLabel("timeframe", "30_days"), "within 30 days");
  assert.equal(auditAnswerLabel("team", "6_20"), "6-20 people");
  assert.equal(auditAnswerLabel("revenue", "renamed_option"), "renamed option", "an unknown key still shows, never blanks");
  assert.equal(auditAnswerLabel("team", ""), null);
  assert.equal(auditAnswerLabel("team", undefined), null);
  console.log("  ok - stored audit answers read as labels");

  // 11. The confirmation email stands on its own for someone who closed the tab.
  const { composeAiAuditWelcome } = await import("../lib/forms/ai-audit-format");
  const lead = { name: "Dana", company: "Dana Co", wants_call: "yes", team_size: "6_20" };
  const bookUrl = "https://oasisai.work/f/oasis-ai-cc/ai-audit/TOKEN?book=1";
  const plain = composeAiAuditWelcome(lead);
  assert.match(plain.body, /live calendar on the page/, "without a link the copy is unchanged");
  assert.ok(!plain.body.includes("go/community"), "no community line unless the consent gate allowed it");
  const withLink = composeAiAuditWelcome(lead, { bookingUrl: bookUrl });
  assert.ok(withLink.body.includes(bookUrl), "the booking link is in the email");
  assert.ok(!withLink.body.includes("live calendar on the page"), "and the email no longer points at a page they have closed");
  for (const wants of ["yes", "no"]) {
    for (const timeframe of ["immediate", "exploring"]) {
      const body = composeAiAuditWelcome({ ...lead, wants_call: wants, timeframe }, { bookingUrl: bookUrl }).body;
      assert.ok(body.includes(bookUrl), `every variant carries the link (wants_call=${wants}, ${timeframe})`);
    }
  }
  const community = "https://oasisai.work/go/community?from=audit_email";
  const withCommunity = composeAiAuditWelcome(lead, { bookingUrl: bookUrl, communityUrl: community });
  assert.ok(withCommunity.body.includes(community));
  assert.match(withCommunity.body, /free OASIS community/);
  console.log("  ok - the confirmation email carries a booking link, and the community line only when passed");

  // 12. The signed link reopens the calendar only for a finished form, on the one form.
  const page = readFileSync(join(__dirname, "..", "app", "f", "[tenant_slug]", "[form_slug]", "[lead_token]", "page.tsx"), "utf8");
  assert.match(page, /sp\.book === "1"/);
  assert.match(page, /result\.bookingReady/);
  assert.match(page, /isPublicFunnelReadyForBooking\(ld\)/);
  assert.match(page, /result\.tenant_slug === AI_AUDIT_TENANT_SLUG/);
  assert.match(page, /isPublicBookingFormSlug\(result\.form\.slug\)/);
  const client = readFileSync(join(__dirname, "..", "components", "forms", "FormPublicClient.tsx"), "utf8");
  assert.match(client, /useState\(Boolean\(resumeBooking\)\)/);
  const notify = readFileSync(join(__dirname, "..", "lib", "forms", "ai-audit-notify.ts"), "utf8");
  assert.match(notify, /marketingSendAllowed\([\s\S]{0,200}channel:\s*"email"/, "the community line is behind the consent gate");
  assert.match(notify, /verdict\.allow\)\s*links\.communityUrl/);
  console.log("  ok - ?book=1 reopens the calendar only for a finished audit lead; the community line is consent-gated");

  console.log("funnel-sales-alerts: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
