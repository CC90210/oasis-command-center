/**
 * tests/funnel-sales-alerts.test.ts - a new lead reaches CC's sales desk.
 *
 * OASIS became CC's sole proprietorship on 2026-10-21. The former shared-sales
 * group credentials must be ignored even if a stale deployment still has them.
 * These pin what makes that safe:
 *
 *   1. sales and operator alerts both deliver to CC;
 *   2. stale group credentials never change the destination;
 *   3. a failure of CC's lane is reported honestly;
 *   4. the booked-call alert escapes and caps everything a stranger typed, shows
 *      Toronto time, and only links a real Google Meet URL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

  // 1. The sales lane delivers to CC's chat.
  {
    const { sent, restore } = stubFetch(new Set());
    const r = await pushWorkspaceAlert(OASIS, "new lead", { desk: "sales" });
    restore();
    assert.equal(r.delivered, true, r.outcome);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, CC_DM, "with no group configured the alert must still reach CC");
    assert.equal(sent[0].token, "cc-token");
  }
  console.log("  ok - sales reaches CC's chat");

  // 2. Stale former-group config is ignored; both lanes remain CC-only.
  process.env.OASIS_SALES_TELEGRAM_CHAT_ID = GROUP;
  process.env.OASIS_SALES_TELEGRAM_BOT_TOKEN = "retired-group-token";
  {
    const { sent, restore } = stubFetch(new Set());
    const sales = await pushWorkspaceAlert(OASIS, "new lead", { desk: "sales" });
    const operator = await pushWorkspaceAlert(OASIS, "cron failed");
    restore();
    assert.equal(sales.delivered && operator.delivered, true);
    assert.deepEqual(sent.map((s) => s.chatId), [CC_DM, CC_DM], "both OASIS lanes stay with CC");
    assert.ok(sent.every((s) => s.token === "cc-token"), "retired group token was not used");
  }
  console.log("  ok - stale former-group credentials are ignored");

  // 3. Failure of the retired group address is irrelevant to CC's lane.
  {
    const { sent, restore } = stubFetch(new Set([GROUP]));
    const r = await pushWorkspaceAlert(OASIS, "Dana Lead booked", { desk: "sales" });
    restore();
    assert.equal(r.delivered, true);
    assert.deepEqual(sent.map((s) => s.chatId), [CC_DM]);
    assert.match(sent[0].text, /Dana Lead booked/);
  }
  console.log("  ok - retired group availability cannot affect CC alerts");

  // 4. Everything down: an honest failure, so the funnel records a marker.
  {
    const { restore } = stubFetch(new Set([CC_DM]));
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
  const oasisAlert = buildBookedLeadAlert({
    offerName: "OASIS audit",
    name: "Dana Lead",
    company: "Dana Co",
    revenue: "$10-50K/mo",
    bottleneck: "Leads wait days",
    startsAt: "2026-10-16T18:30:00.000Z",
    meetUrl: "https://oasisai.work/meet/abc-defg-hjk",
    leadUrl: "https://oasisai.work/pipeline/L1",
  });
  assert.match(oasisAlert, /href="https:\/\/oasisai\.work\/meet\/abc-defg-hjk"/);
  assert.match(oasisAlert, /Open video call/);
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

  // 8b. Revenue and Bottleneck lines on the sales alerts (CC 2026-10-16): the
  //     completed alert had "Wants:" and "In their words" but no Bottleneck line.
  const { alertLeadFactLines, leadRevenueAndBottleneck } = await import("../lib/forms/ai-audit-format");
  {
    const full = { name: "Ada", company: "Acme", monthly_revenue: "10k_50k", automation_goal: "sales_leadgen", bottleneck_detail: "Quotes sit <3 days> unanswered" };
    const completed = buildAiAuditAlert(full, scoreAiAuditLead(full));
    assert.match(completed, /Revenue: \$10-50K\/mo/, "revenue as words, not the option key");
    assert.match(completed, /Bottleneck: Quotes sit &lt;3 days&gt; unanswered/, "the typed bottleneck, escaped");
    assert.match(completed, /Wants: sales \/ lead gen/, "the goal line the alert already had is kept");
    assert.ok(completed.indexOf("Revenue:") < completed.indexOf("Bottleneck:"), "Revenue, then Bottleneck");
    // Never the same words twice (re-audit 2026-10-16): the short typed answer IS the Bottleneck line.
    assert.doesNotMatch(completed, /In their words/, "a short answer already printed whole is not repeated");
    assert.equal(completed.split("Quotes sit &lt;3 days&gt; unanswered").length - 1, 1, "the answer appears once");
    const longAnswer = "Quotes sit unanswered. " + "x".repeat(400);
    const longMsg = buildAiAuditAlert({ ...full, bottleneck_detail: longAnswer }, scoreAiAuditLead(full));
    assert.match(longMsg, /In their words/, "a long answer keeps its full block (the Bottleneck line is capped)");
    const picked = { ...full, primary_bottleneck: "Leads wait days" };
    const pickedMsg = buildAiAuditAlert(picked, scoreAiAuditLead(picked));
    assert.match(pickedMsg, /Bottleneck: Leads wait days/);
    assert.match(pickedMsg, /In their words/, "a picked bottleneck leaves the typed answer its own block");

    // Only the goal answered: the bottleneck reads as the goal's words, never its key, and once.
    const goalOnly = { name: "Bo", automation_goal: "sales_leadgen" };
    const goalMsg = buildAiAuditAlert(goalOnly, scoreAiAuditLead(goalOnly));
    assert.match(goalMsg, /Bottleneck: sales \/ lead gen/);
    assert.doesNotMatch(goalMsg, /Wants:/, "the goal is not printed a second time as Wants");

    // Neither given: neither line, and nothing reads "undefined" or a bare label.
    const bare = { name: "Cy", email: "cy@x.test" };
    const bareMsg = buildAiAuditAlert(bare, scoreAiAuditLead(bare));
    assert.doesNotMatch(bareMsg, /Revenue:|Bottleneck:/, "a missing value drops its whole line");
    assert.doesNotMatch(bareMsg, /undefined|null/);

    // A lead row's own keys are read as well as the form's (the started alert passes the lead).
    assert.deepEqual(alertLeadFactLines({ revenue_band: "50k_250k", primary_bottleneck: "Leads wait days" }), [
      "\ud83d\udcca Revenue: $50-250K/mo",
      "\ud83d\udea7 Bottleneck: Leads wait days",
    ]);
    assert.deepEqual(alertLeadFactLines({ revenue_band: "  ", primary_bottleneck: "" }), [], "blank is missing");
    assert.deepEqual(alertLeadFactLines({ monthly_revenue: "under_10k" }), ["\ud83d\udcca Revenue: &lt;$10K/mo"], "one without the other");
    const long = alertLeadFactLines({ primary_bottleneck: "y".repeat(900) })[0];
    assert.ok(long.length < 330 && !/y{301}/.test(long), "a long bottleneck is capped at 300");
    // The booked-call alert reads the same two facts the same way.
    assert.deepEqual(leadRevenueAndBottleneck({ monthly_revenue: "10k_50k", automation_goal: "sales_leadgen" }), {
      revenue: "$10-50K/mo",
      bottleneck: "sales / lead gen",
    });
    const publicBooking = readFileSync(join(__dirname, "..", "lib", "forms", "public-booking.ts"), "utf8");
    assert.match(publicBooking, /return leadRevenueAndBottleneck\(lead\);/, "bookedLeadFacts must not grow its own copy again");
    // The started alert prints the same lines, from the lead row as well as the answers.
    const notifySrc = readFileSync(join(__dirname, "..", "lib", "forms", "ai-audit-notify.ts"), "utf8");
    assert.match(notifySrc, /alertLeadFactLines\(\{ \.\.\.\(await readLeadData\(db, tenantId, leadId\)\), \.\.\.answers \}\)/);
    assert.match(notifySrc, /\.from\("tenant_records"\)\s*\.select\("data"\)\s*\.eq\("tenant_id", tenantId\)/, "the lead read is scoped to the workspace");
  }
  console.log("  ok - the sales alerts carry Revenue and Bottleneck lines only when the lead has them");

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
  assert.equal(liveTile.hint, "20 untouched \u00b7 7 booked");
  assert.equal(liveTile.action?.href, INBOUND_QUEUE_HREF);
  assert.equal(INBOUND_QUEUE_HREF, "/pipeline?motion=inbound");
  console.log("  ok - the Sales inbound tile is honest when empty, failed and live");

  // 9b. The Sales tab lists the new inbound leads by name in "Needs you".
  const { inboundWaiting, inboundAttention, inboundLeadLine } = await import("../components/os/department/inbound-rules");
  const NOW = Date.parse("2026-10-20T15:00:00.000Z");
  const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const inboundRow = (id: string, ageDays: number, data: Record<string, unknown>) => ({ id, created_at: day(ageDays), data: { stage: "researched", ...data } });
  const rows = [
    inboundRow("a", 1, { name: "Ada Lovelace", company_name: "Acme", monthly_revenue: "10k_50k", funnel_stage: "audit_requested", funnel_form: "ai-audit", primary_bottleneck: "Leads wait days" }),
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
    "Ada Lovelace \u00b7 Acme \u00b7 $10-50K/mo \u00b7 Leads wait days \u00b7 audit done, unbooked - needs follow-up",
    "words, not option keys, and what the lead did",
  );
  assert.equal(inboundLeadLine(rows[1].data), "Bo Chen \u00b7 Bo Co \u00b7 started the form, did not finish");
  // Review of #655: the finished stage is shared by every booking form, so the
  // line names the form; a PROTOCOL buyer or a community joiner is never an "audit".
  assert.equal(
    inboundLeadLine({ name: "Pat Buyer", funnel_stage: "audit_requested", funnel_form: "protocol" }),
    "Pat Buyer \u00b7 finished the PROTOCOL form, unbooked - needs follow-up",
  );
  assert.equal(
    inboundLeadLine({ name: "Cam Joiner", funnel_stage: "audit_requested", funnel_form: "community" }),
    "Cam Joiner \u00b7 finished the community form, unbooked - needs follow-up",
  );
  assert.equal(
    inboundLeadLine({ name: "Old Lead", funnel_stage: "audit_requested" }),
    "Old Lead \u00b7 finished the form, unbooked - needs follow-up",
    "a lead finished before the form was stamped is not guessed to be an audit",
  );
  assert.equal(
    inboundLeadLine({ name: "Old Audit", funnel_stage: "audit_requested", ai_audit_scored_at: "2026-10-15T12:00:00.000Z" }),
    "Old Audit \u00b7 audit done, unbooked - needs follow-up",
    "an unstamped lead the AI audit scored proves it came through the audit",
  );
  assert.equal(
    inboundLeadLine({ name: "Later Buyer", funnel_stage: "audit_requested", funnel_form: "protocol", ai_audit_scored_at: "2026-10-15T12:00:00.000Z" }),
    "Later Buyer \u00b7 finished the PROTOCOL form, unbooked - needs follow-up",
    "the stamp of the form finished last wins over an older audit score",
  );
  for (const form of ["protocol", "community", "command", "fleet", "book", undefined]) {
    assert.ok(!/audit/i.test(inboundLeadLine({ name: "X", funnel_stage: "audit_requested", funnel_form: form })), `${form} reads as an audit`);
  }
  const items = inboundAttention({ ok: true, value: { total: 9, untouched: 9, booked: 1, waiting } });
  assert.equal(items.length, 6, "five leads and one 'more' line");
  assert.equal(items[0].href, "/pipeline/b");
  assert.ok(items.every((i) => !/[_]\d|10k_50k|sales_leadgen/.test(i.label)), "no raw option keys on screen");
  assert.equal(items.reduce((s, i) => s + i.count, 0), 7, "the header's Needs you counts each waiting lead once");
  assert.equal(items[5].capped, true, "a truncated window makes the sum a floor");
  assert.match(items[5].label, /^2 more new inbound leads waiting in Warm inbound$/);
  // A capped read that shows every row it read cannot say how many are missing: it says "may".
  const exactlyFive = inboundWaiting(rows.slice(0, 5), NOW, 9);
  const cappedOnly = inboundAttention({ ok: true, value: { total: 9, untouched: 9, booked: 0, waiting: exactlyFive } });
  assert.equal(cappedOnly.at(-1)?.label, "There may be more new inbound leads waiting in Warm inbound");
  assert.equal(cappedOnly.at(-1)?.count, 0);
  assert.equal(cappedOnly.at(-1)?.capped, true);
  assert.deepEqual(inboundAttention(null), []);
  assert.deepEqual(inboundAttention({ ok: false }), []);
  assert.deepEqual(inboundAttention({ ok: true, value: { total: 3, untouched: 0, booked: 0 } }), [], "no list where it was not read");
  assert.deepEqual(inboundAttention({ ok: true, value: { total: 0, untouched: 0, booked: 0, waiting: inboundWaiting([], NOW, 0) } }), []);
  console.log("  ok - the Sales tab names the new inbound leads waiting for a person");

  // 9c. "New inbound leads (14 days)" on the Sales desk, and the badge count (CC 2026-10-16).
  {
    const { inboundRecent, INBOUND_RECENT_SHOWN } = await import("../components/os/department/inbound-rules");
    const { funnelStageLabel } = await import("../lib/forms/ai-audit-format");
    assert.equal(funnelStageLabel("inbound_lead"), "Inbound lead");
    assert.equal(funnelStageLabel("audit_requested", "ai-audit"), "Audit requested");
    assert.equal(funnelStageLabel("audit_requested", " AI-Audit "), "Audit requested");
    assert.equal(funnelStageLabel("audit_requested", "protocol"), "PROTOCOL form finished");
    assert.equal(funnelStageLabel("audit_requested", "community"), "community form finished");
    assert.equal(funnelStageLabel("audit_requested", "command"), "COMMAND form finished");
    assert.equal(funnelStageLabel("audit_requested", "book"), "Book a call form finished");
    assert.equal(funnelStageLabel("audit_requested"), "Form finished", "no stamp: never guessed to be an audit");
    assert.equal(funnelStageLabel("audit_requested", "constructor"), "Form finished", "own keys only");
    assert.equal(funnelStageLabel("meeting_booked"), "Meeting booked");
    assert.equal(funnelStageLabel("call_no_show"), "Call no show", "a stage added later still reads as words");
    assert.equal(funnelStageLabel(""), null, "no funnel stage, no chip");
    assert.equal(funnelStageLabel(undefined), null);

    const at = (ageDays: number) => new Date(NOW - ageDays * 86_400_000).toISOString();
    const row = (id: string, ageDays: number, data: Record<string, unknown>, updatedAgeDays = ageDays) => ({
      id, created_at: at(ageDays), updated_at: at(updatedAgeDays), data,
    });
    const stamp = (iso: string) => `T(${iso})`;
    const recentRows = [
      row("booked", 2, { stage: "founder_meeting_booked", name: "Dana Booked", company: "Dana Co", revenue_band: "50k_250k", funnel_stage: "meeting_booked", founder_meeting_at: "2026-10-22T18:30:00.000Z" }),
      row("fresh", 0.1, { stage: "researched", name: "Eve Fresh", company_name: "Eve Inc", monthly_revenue: "10k_50k", funnel_stage: "audit_requested", funnel_form: "ai-audit" }),
      row("bare", 1, { stage: "assigned" }),
      row("stale", 20, { stage: "lost", name: "Too Old", funnel_stage: "inbound_lead" }),
    ];
    const list = inboundRecent(recentRows, NOW, [], stamp);
    assert.equal(list.total, 3, "any stage, created inside 14 days; the 20-day-old lead is out");
    assert.deepEqual(list.leads.map((l) => l.id), ["fresh", "bare", "booked"], "newest first");
    assert.deepEqual(list.leads[0], {
      id: "fresh", name: "Eve Fresh", company: "Eve Inc", revenue: "$10-50K/mo",
      stage: "Audit requested", booked: "Unbooked", href: "/pipeline/fresh",
    });
    assert.equal(list.leads[2].booked, "T(2026-10-22T18:30:00.000Z)", "a booked call shows its time, through the alert's formatter");
    assert.equal(list.leads[2].stage, "Meeting booked");
    assert.deepEqual(
      { name: list.leads[1].name, company: list.leads[1].company, revenue: list.leads[1].revenue, stage: list.leads[1].stage },
      { name: "New lead", company: null, revenue: null, stage: null },
      "a lead with nothing on file has no empty facts, only a name",
    );
    assert.equal(list.truncated, false);

    const many = Array.from({ length: 13 }, (_, i) => row(`m${i}`, 1 + i * 0.1, { stage: "researched", name: `Lead ${i}` }));
    const capped = inboundRecent(many, NOW, [], stamp);
    assert.equal(capped.total, 13, "the count is every new lead");
    assert.equal(capped.leads.length, INBOUND_RECENT_SHOWN, "the list stops at its cap");

    // Truncation: a capped stage whose oldest kept row is older than the window
    // cannot hide a new lead, so the count is exact; one updated inside it can.
    const lostKept = [row("n1", 1, { stage: "researched", name: "New" }), row("old-lost", 40, { stage: "lost" }, 30)];
    assert.equal(inboundRecent(lostKept, NOW, ["lost"], stamp).truncated, false, "an old, long stage does not make the count a floor");
    const busyKept = [row("n2", 1, { stage: "researched", name: "New" }, 0.5)];
    assert.equal(inboundRecent(busyKept, NOW, ["researched"], stamp).truncated, true, "a capped stage still busy inside the window may hide a new lead");
    assert.equal(inboundRecent([row("x", 1, { stage: "lost" }, 1)].map((r) => ({ ...r, updated_at: null })), NOW, ["lost"], stamp).truncated, true, "no timestamp is no proof");

    // Rendered: the titled list with its count, rows linking to the lead.
    // next/link and the composer context call createContext at import time,
    // which react-server does not have: stand-ins, as tests/os-approvals.test.ts.
    const ReactNS = await import("react");
    const { createElement } = ReactNS;
    // tsx compiles the panel's JSX to React.createElement.
    (globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
    const stub =(request: string, exports: Record<string, unknown>) => {
      const p = require.resolve(request);
      require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
    };
    stub("next/link", {
      __esModule: true,
      default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
        createElement("a", { href, ...rest }, children as never),
    });
    stub("../components/os/department/ComposerContext", {
      __esModule: true,
      ComposerProvider: ({ children }: { children?: unknown }) => children,
      useComposer: () => {
        throw new Error("client hook called under react-server");
      },
    });
    const { OverviewPanel, NewInboundLeads } = await import("../components/os/department/OverviewPanel");
    // The text a viewer reads: server components are called, and only children
    // are followed (a className is not on screen). A client component (hooks)
    // throws when called bare; its children are what it would render.
    const strings = (node: unknown, out: string[] = []): string[] => {
      if (node === null || node === undefined || typeof node === "boolean") return out;
      if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
      if (Array.isArray(node)) { for (const n of node) strings(n, out); return out; }
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (!el.props) return out;
      if (typeof el.type === "function") {
        try { return strings((el.type as (p: unknown) => unknown)(el.props), out); } catch { /* client component */ }
      }
      return strings(el.props.children, out);
    };
    const hrefs = (node: unknown, out: string[] = []): string[] => {
      if (!node || typeof node !== "object") return out;
      if (Array.isArray(node)) { for (const n of node) hrefs(n, out); return out; }
      const el = node as { props?: Record<string, unknown> };
      if (!el.props) return out;
      if (typeof el.props.href === "string") out.push(el.props.href);
      return hrefs(el.props.children, out);
    };
    const rendered = NewInboundLeads({ read: { ok: true, value: list } });
    const text = strings(rendered).join("");
    assert.match(text, /Eve Fresh/);
    assert.match(text, /Audit requested/);
    assert.match(text, /Eve Inc \u00b7 \$10-50K\/mo \u00b7 Unbooked/);
    assert.match(text, /Dana Co \u00b7 \$50-250K\/mo \u00b7 T\(2026-10-22/);
    assert.ok(!/undefined|null/.test(text), "no empty fact prints as a word");
    assert.deepEqual(hrefs(rendered), ["/pipeline/fresh", "/pipeline/bare", "/pipeline/booked"]);
    const more = strings(NewInboundLeads({ read: { ok: true, value: capped } })).join("");
    assert.match(more, /3 more in Warm inbound/);
    assert.match(strings(NewInboundLeads({ read: { ok: false } })).join(""), /Couldn\u2019t load new inbound leads/, "a failed read is not an empty list");
    assert.match(strings(NewInboundLeads({ read: { ok: true, value: inboundRecent([], NOW, [], stamp) } })).join(""), /No new inbound leads in the last 14 days/);

    const base = { attention: [], approvals: { ok: true as const, value: { items: [], total: 0 } }, feedHref: null, tiles: [], routines: { ok: true as const, value: [] }, connections: [], canManageConnections: true, asks: [] };
    const panel = strings(OverviewPanel({ ...base, newInbound: { ok: true, value: capped } })).join("|");
    assert.match(panel, /New inbound leads \(14 days\)\|13\|/, "the titled list carries the same count the badge prints");
    assert.match(strings(OverviewPanel({ ...base, newInbound: { ok: true, value: { ...capped, truncated: true } } })).join("|"), /\|13\+\|/, "a floor prints as N+");
    assert.doesNotMatch(strings(OverviewPanel(base)).join("|"), /New inbound leads/, "no scope, no section");

    // One read behind the list, the tile, Needs you and the /pipeline badge.
    const numbersSrc = readFileSync(join(__dirname, "..", "components", "os", "department", "numbers.ts"), "utf8");
    assert.match(numbersSrc, /readOasisInboundQueue\(\{/);
    assert.doesNotMatch(numbersSrc, /listOasisPipelineWindow\(\{[\s\S]{0,300}OASIS_INBOUND_WARM_MOTION/, "numbers.ts grew a second inbound reader");
    assert.match(numbersSrc, /newInbound: inbound === null \? null : inbound\.ok \? \{ ok: true, value: inbound\.value\.recent \}/);
    const loadSrc = readFileSync(join(__dirname, "..", "components", "os", "department", "inbound-load.ts"), "utf8");
    assert.match(loadSrc, /salesMotion: OASIS_INBOUND_WARM_MOTION/);
    assert.match(loadSrc, /tenantId: scope\.tenantId/);
    assert.match(loadSrc, /recent: inboundRecent\(window\.rows, now, window\.truncatedStages, formatBookedTime\)/);
    const deptPage = readFileSync(join(__dirname, "..", "app", "team", "[dept]", "page.tsx"), "utf8");
    assert.match(deptPage, /newInbound: numbers\.newInbound \?\? null/);
    const pipelinePage = readFileSync(join(__dirname, "..", "app", "pipeline", "page.tsx"), "utf8");
    assert.match(pipelinePage, /session\.ok && pipelineAdmin && !badgeFromBoard\s*\?\s*readOasisInboundQueue\(/, "the badge is the same read, for pipeline admins only");
    // On the plain Warm inbound view the board IS that read: the badge reuses it, never a second read.
    assert.match(pipelinePage, /const badgeFromBoard = warmInbound && !stageFilter && !repFilter && !query && !requestedPage;/);
    assert.match(pipelinePage, /session\.ok && pipelineAdmin && badgeFromBoard \? badgeOf\(inboundQueueFromWindow\(pipelineWindow\)\)/);
    const inboundLoadSrc = readFileSync(join(__dirname, "..", "components", "os", "department", "inbound-load.ts"), "utf8");
    assert.match(inboundLoadSrc, /return inboundQueueFromWindow\(window\);/, "one derivation for the badge and the Sales desk");
    assert.match(pipelinePage, /tileCount\(recent\.total, recent\.truncated\)/, "the badge prints the list's count, N+ when it is a floor");
    assert.match(pipelinePage, /<span>Warm inbound<\/span>\s*\{inboundBadge && \(/);
  }
  console.log("  ok - the Sales desk lists new inbound leads (14 days) and /pipeline badges the same count");

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
