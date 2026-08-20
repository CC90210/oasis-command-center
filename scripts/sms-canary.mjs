/**
 * scripts/sms-canary.mjs — commission phone lines by proving they deliver.
 *
 * WHY THIS EXISTS. On 2026-08-18 the AI Follow-Up wire delivered 8 of 8 and we
 * started sending on it. Roughly 22 hours later the carriers were refusing
 * every message from those two numbers, and nothing in the system noticed for
 * two days. A first-day burst is what a number does BEFORE the carriers decide
 * about it, so "it worked once" is not a commissioning test.
 *
 * A line is cleared only by two deliveries at least 30 minutes apart, with no
 * refusal since. Rules: lib/sms/canary-core.ts. I/O: lib/sms/canary.ts.
 *
 * Usage (from the repo root):
 *   node --conditions=react-server --import tsx scripts/sms-canary.mjs discover
 *   node --conditions=react-server --import tsx scripts/sms-canary.mjs send [--to +1...] [--only +1...,+1...]
 *   node --conditions=react-server --import tsx scripts/sms-canary.mjs status
 *
 * `send` costs one real text per line. Run it, wait 30+ minutes, run it again,
 * then `status`. Two spaced rounds is the whole point; back-to-back rounds
 * cannot clear anything.
 */

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Every line we own, with the identity needed to send from it.
 *
 * Discovered from the provider rather than hardcoded, because the numbers
 * ROTATE (roughly weekly) and a stale list would test lines we no longer hold
 * while ignoring the ones the engine is actually using.
 */
async function discoverLines() {
  const { getTextTorrentCredentials } = await import("@/lib/integrations/texttorrent");
  const { AI_WIRE_ACT_AS, AI_WIRE_REP_KEY, AI_WIRE_SERVICE } = await import("@/lib/drips/ai-wire-core");
  const { repKeyForOwner, actAsEmailForRep } = await import("@/lib/drips/rep-keys");

  // The AI wire authenticates against the Legacy parent; every other rep wire
  // sits on the main account. Both are enumerated so a comparison is possible:
  // "our line is dead" and "all lines are dead" need completely different fixes.
  const accounts = [
    { service: AI_WIRE_SERVICE, actAs: AI_WIRE_ACT_AS },
    { service: "texttorrent", actAs: null },
  ];

  const lines = [];
  const seen = new Set();
  for (const acct of accounts) {
    let creds;
    try {
      creds = await getTextTorrentCredentials(TENANT, { service: acct.service, actAsEmail: acct.actAs });
    } catch (err) {
      console.log(`  (${acct.service}: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const res = await fetch("https://api.texttorrent.com/api/v1/inbox/numbers/active?limit=100", {
      headers: {
        "X-API-SID": creds.apiSid,
        "X-API-PUBLIC-KEY": creds.publicKey,
        ...(acct.actAs ? { "X-ACT-AS-USER": acct.actAs } : {}),
        Accept: "application/json",
      },
    });
    const j = await res.json().catch(() => ({}));
    for (const n of j?.data?.data || j?.data || []) {
      const number = String(n.number || "").trim();
      if (!number || seen.has(number)) continue;
      seen.add(number);
      const owner = String(n.purchased_by_user || "");
      const wire = repKeyForOwner(owner);
      lines.push({
        number,
        wire,
        owner,
        service: wire === AI_WIRE_REP_KEY ? AI_WIRE_SERVICE : "texttorrent",
        actAsEmail: wire === AI_WIRE_REP_KEY ? AI_WIRE_ACT_AS : actAsEmailForRep(wire),
      });
    }
  }
  return lines;
}

function printStatus(results) {
  const ICON = { cleared: "PASS", failed: "FAIL", pending: "wait", insufficient: "----" };
  console.log("\nLINE            WIRE         VERDICT  deliv fail none  DETAIL");
  for (const r of results) {
    console.log(
      `${r.number.padEnd(15)} ${String(r.wire || "").padEnd(12)} ${ICON[r.verdict].padEnd(8)} ` +
      `${String(r.delivered).padStart(5)} ${String(r.failed).padStart(4)} ${String(r.unresolved).padStart(4)}  ${r.reason}`,
    );
  }
}

const verb = process.argv[2] || "status";

if (verb === "discover") {
  const lines = await discoverLines();
  console.log(`${lines.length} line(s):`);
  for (const l of lines) console.log(`  ${l.number.padEnd(15)} wire=${l.wire.padEnd(12)} owner="${l.owner}" acct=${l.service}`);
} else if (verb === "send") {
  const to = arg("to", process.env.SMS_CANARY_TO);
  if (!to) {
    console.error("Refusing to send without an explicit destination. Pass --to +1XXXXXXXXXX (a handset you control).");
    process.exit(2);
  }
  const only = (arg("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  let lines = await discoverLines();
  if (only.length) lines = lines.filter((l) => only.includes(l.number));
  if (!lines.length) { console.error("No lines matched."); process.exit(2); }

  const { sendCanaries } = await import("@/lib/sms/canary");
  console.log(`Sending 1 canary from each of ${lines.length} line(s) to ${to}...`);
  const sent = await sendCanaries(TENANT, lines, to);
  for (const s of sent) {
    console.log(`  ${s.line.number.padEnd(15)} ${s.ok ? `sent (chat ${s.chatId})` : `ERROR: ${s.error}`}`);
  }
  const ok = sent.filter((s) => s.ok).length;
  console.log(`\n${ok}/${sent.length} accepted by the provider. Acceptance is NOT delivery.`);
  console.log("Wait for the reconciler (runs every 15 min), then: sms-canary.mjs status");
  console.log("A line needs TWO rounds at least 30 minutes apart before it can clear.");
} else {
  const { canaryStatus } = await import("@/lib/sms/canary");
  const lines = await discoverLines();
  const byNumber = new Map(lines.map((l) => [l.number, l]));
  const { results, error } = await canaryStatus(TENANT, { lines: lines.map((l) => l.number) });
  if (error) {
    console.error(`Could not read canary history: ${error}`);
    console.error("This is UNKNOWN, not 'no line has been tested'. Do not resume on this output.");
    process.exit(1);
  }
  printStatus(results.map((r) => ({ ...r, wire: byNumber.get(r.number)?.wire ?? "" })));

  const { resumeAllowed } = await import("@/lib/sms/canary-core");
  const verdict = resumeAllowed(results);
  console.log(`\nRESUME: ${verdict.ok ? "ALLOWED" : "BLOCKED"} - ${verdict.reason}`);
  process.exit(verdict.ok ? 0 : 1);
}
