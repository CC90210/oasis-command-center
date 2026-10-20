/**
 * tests/telegram-safe-cut.test.ts — a long alert reaches Telegram whole, cut
 * on a boundary its HTML parser accepts.
 *
 * The sender cut every message at 4,096 characters with a plain slice. An
 * escaped name ("&amp;" five characters at a time) could put the cut inside an
 * escape or a tag, and Telegram's HTML parse mode then refused the whole
 * message ("can't parse entities"): the alert was lost, not just its tail
 * (independent review of OCC #718). The alert builders' own cut ("trim, slice,
 * escape") could also leave half an emoji.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clipAndEscape, fitTelegramHtml, TELEGRAM_TEXT_MAX } from "../lib/notify/telegram-format";
import { repoRelative, sourceTree } from "./_tree";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** What Telegram's HTML parser needs: every & starts a whole escape, no tag is cut, every tag closes, no lone surrogate. */
function assertParses(html: string, label: string): void {
  for (let i = html.indexOf("&"); i >= 0; i = html.indexOf("&", i + 1)) {
    assert.match(html.slice(i, i + 10), /^&(amp|lt|gt|quot|#\d+);/, `${label}: a cut escape at ${i}: ${JSON.stringify(html.slice(i, i + 10))}`);
  }
  assert.equal((html.match(/</g) ?? []).length, (html.match(/>/g) ?? []).length, `${label}: a cut tag`);
  const open: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!m[1]) open.push(m[2]);
    else assert.equal(open.pop(), m[2], `${label}: </${m[2]}> closes something else`);
  }
  assert.deepEqual(open, [], `${label}: tags left open`);
  assert.doesNotMatch(html, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `${label}: half an emoji`);
}

async function main(): Promise<void> {
  console.log("telegram-safe-cut:");

  await check("a message within the limit goes as it is", () => {
    const text = `<b>New lead</b>\nAnn &amp; Co`;
    assert.equal(fitTelegramHtml(text), text);
    const exact = "x".repeat(TELEGRAM_TEXT_MAX);
    assert.equal(fitTelegramHtml(exact), exact);
  });

  await check("a cut that would land inside an escape backs off before it", () => {
    // 4,093 + "&amp;" puts a plain slice at "&am".
    const text = "a".repeat(4093) + "&amp;".repeat(5);
    const fitted = fitTelegramHtml(text);
    assert.ok(fitted.length <= TELEGRAM_TEXT_MAX, `length ${fitted.length}`);
    assert.ok(fitted.endsWith("…"));
    assertParses(fitted, "escape");
  });

  await check("a cut that would land inside a tag backs off, and the tags still open are closed, innermost first", () => {
    const text = `<b><i>${"x".repeat(4087)}<a href="https://oasisai.work/pipeline/1">lead</a></i></b>`;
    const fitted = fitTelegramHtml(text);
    assert.ok(fitted.length <= TELEGRAM_TEXT_MAX, `length ${fitted.length}`);
    assert.ok(fitted.endsWith("…</i></b>"), fitted.slice(-20));
    assertParses(fitted, "tag");
  });

  await check("a cut never leaves half an emoji", () => {
    const text = "x".repeat(4094) + String.fromCodePoint(0x1f4c5) + "tail";
    const fitted = fitTelegramHtml(text);
    assert.ok(fitted.length <= TELEGRAM_TEXT_MAX);
    assertParses(fitted, "emoji");
  });

  await check("any mix of text, escapes, tags and emoji fits and parses", () => {
    // Deterministic: a fixed seed, so a failure reproduces.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const parts = ["word ", "&amp;", "&lt;", String.fromCodePoint(0x1f600), "\n"];
    for (let run = 0; run < 200; run += 1) {
      let text = "";
      const wrap = rand(3);
      while (text.length < 4000 + rand(400)) text += parts[rand(parts.length)];
      text = wrap === 0 ? text : wrap === 1 ? `<b>${text}</b>` : `<b>Lead</b>\n<i>${text}</i>\n<a href="https://oasisai.work/x">open</a>`;
      const fitted = fitTelegramHtml(text);
      assert.ok(fitted.length <= TELEGRAM_TEXT_MAX, `run ${run}: length ${fitted.length}`);
      assertParses(fitted, `run ${run}`);
    }
  });

  await check("a value is cut on whole characters before it is escaped", () => {
    assert.equal(clipAndEscape("  Ann <Smith> & Co  ", 7), "Ann &lt;Sm");
    assert.equal(clipAndEscape("&&&&", 2), "&amp;&amp;", "never inside an escape");
    const emoji = String.fromCodePoint(0x1f600);
    assert.equal(clipAndEscape(emoji.repeat(3), 2), emoji.repeat(2), "never half an emoji");
    assert.equal(clipAndEscape("short", 120), "short");
  });

  await check("the booking alerts cut a name on whole characters, before escaping", async () => {
    const { buildBookedLeadAlert, buildDetailsOnlyLeadAlert } = await import("../lib/forms/public-booking-alert");
    const emoji = String.fromCodePoint(0x1f600);
    // 119 letters then an emoji: a cut by code units at 120 split it.
    const name = "N".repeat(119) + emoji + "rest";
    const booked = buildBookedLeadAlert({
      offerName: "AI audit",
      name,
      company: "&".repeat(200),
      revenue: "",
      bottleneck: "",
      startsAt: "2026-10-21T15:00:00Z",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      leadUrl: "https://oasisai.work/pipeline/1",
    });
    assertParses(booked, "booked");
    assert.ok(booked.includes(`<b>${"N".repeat(119)}${emoji}</b>`), "the name keeps its last whole character");
    assert.ok(booked.includes(` - ${"&amp;".repeat(120)}\n`), "the company is cut at 120 characters, then escaped");
    const left = buildDetailsOnlyLeadAlert({ offerName: "AI audit", name, company: "", reason: "no_times", leadUrl: "https://oasisai.work/pipeline/1" });
    assertParses(left, "details-only");
  });

  await check("no Telegram builder cuts a value by code units before escaping it", async () => {
    // Every value goes through clipAndEscape (whole characters). A guard, not
    // a style rule: a cut by code units can leave half an emoji, which
    // Telegram refuses, losing the alert.
    const offenders: string[] = [];
    for (const file of sourceTree("app", "lib")) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("escapeTelegramHtml")) continue;
      src.split("\n").forEach((line, i) => {
        if (/\be\([^\n]*\.slice\(0,\s*\d+\)|escapeTelegramHtml\([^\n]*\.slice\(0,\s*\d+\)/.test(line)) offenders.push(`${repoRelative(file)}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [], "use clipAndEscape(value, max)");
  });

  await check("the sender cuts through the safe cut: a long escaped alert reaches Telegram parseable", async () => {
    process.env.OASIS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.OASIS_TELEGRAM_CHAT_ID = "555000";
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const { sendTelegram } = await import("../lib/notify/telegram");
      const res = await sendTelegram(`<b>${"Ann &amp; Co ".repeat(400)}</b>`, { lane: "operator" });
      assert.equal(res.ok, true, JSON.stringify(res));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(sent.length, 1);
    assert.ok(sent[0].length <= TELEGRAM_TEXT_MAX, `length ${sent[0].length}`);
    assertParses(sent[0], "sent");
  });

  if (failures) {
    console.error(`telegram-safe-cut: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("telegram-safe-cut: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
