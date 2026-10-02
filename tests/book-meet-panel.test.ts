/**
 * The Book the Meet form, pinned against its rendered markup in every state a
 * rep can see (book-the-meet plan, Task 7).
 * Run: node --conditions=react-server --import tsx tests/book-meet-panel.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { QUALIFICATION_GATES } from "../lib/sales-qualification";

// The renderer needs the default (client) React build, so drop any
// --conditions the suite put in NODE_OPTIONS (same as
// web-leads-automations-catalogue.test.ts). Both spellings are stripped.
// tests/tsconfig.render.json switches tsx to the automatic JSX runtime; the
// root tsconfig's jsx:"preserve" would leave React undefined in the component.
const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" };
const tokens = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t.length > 0);
const kept: string[] = [];
for (let i = 0; i < tokens.length; i += 1) {
  if (tokens[i] === "--conditions" || tokens[i] === "-C") { i += 1; continue; }
  if (/^(--conditions=|-C=)/.test(tokens[i])) continue;
  kept.push(tokens[i]);
}
if (kept.length) childEnv.NODE_OPTIONS = kept.join(" ");
else delete childEnv.NODE_OPTIONS;

const r = spawnSync(process.execPath, ["--import", "tsx", "tests/book-meet-panel.render.ts"], { encoding: "utf8", env: childEnv });
assert.equal(r.status, 0, `renderer failed:\n${r.stderr}`);
const html: Record<string, string> = JSON.parse(r.stdout);

// Gate wording on the call screen.
assert.match(html.idle, /Operations pain named in their own words/);
assert.doesNotMatch(html.idle, /Website problem/);
// Every gate label from the shared list (the same words Pipeline shows).
for (const gate of QUALIFICATION_GATES) assert.ok(html.idle.includes(gate.label), `gate label missing: ${gate.label}`);
// Their words field sits under the pain gate.
assert.match(html.idle, /Their words/);

// Time zone: the prospect's local time AND Eastern are both shown.
assert.match(html.idle, /Pacific time/);
assert.match(html.idle, /5:00 p\.m\..*Eastern|Eastern.*5:00 p\.m\./s, "the Eastern equivalent of 2 p.m. Pacific must be visible");

// No email: required, with the question to ask.
assert.match(html.noEmail, /required/);
assert.match(html.noEmail, /best email for the calendar invite/);

// Alternates are one tap.
assert.match(html.idle, /info@canary\.test/);

// Blocked lead: reason shown, no form.
assert.match(html.blocked, /role="alert"/);
assert.match(html.blocked, /Claim it again first/);
assert.doesNotMatch(html.blocked, /type="checkbox"/);

// Working: the button says what is happening and is disabled.
assert.match(html.working, /Booking with Google/);
assert.match(html.working, /aria-busy="true"/);

// Unconfirmed: alert, Try again, 15-minute warning, fields read-only.
assert.match(html.unconfirmed, /role="alert"/);
assert.match(html.unconfirmed, /Try again/);
assert.match(html.unconfirmed, /15 minutes/);
assert.match(html.unconfirmed, /readonly|disabled/);

// Retry-safe: the message says "Press Try again", so the button must say it too.
assert.match(html.retrySafe, /role="alert"/);
assert.match(html.retrySafe, /<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?Try again<\/button>/);

// Field error: alert names the email field.
assert.match(html.fixEmail, /role="alert"/);
assert.match(html.fixEmail, /aria-invalid="true"/);

// Do-not-call: the owner-asked box is shown, unticked, never inferred.
assert.match(html.dnc, /The owner asked for this meeting on this call/);
assert.doesNotMatch(html.idle, /The owner asked for this meeting/, "the do-not-call box appears only for a do-not-call lead");
const dncBox = html.dnc.match(/<input[^>]*type="checkbox"[^>]*>(?=<span>The owner asked)/)?.[0] ?? "";
assert.ok(dncBox, "the owner-asked confirmation is a native checkbox");
assert.doesNotMatch(dncBox, /checked/, "the owner-asked box starts unticked");

// Booked: status role, Meet link, both times; Call Mode offers Next lead.
assert.match(html.booked, /role="status"/);
assert.match(html.booked, /https:\/\/meet\.google\.com\/abc-defg-hij/);
assert.match(html.booked, /tabular-nums/);
assert.match(html.callmodeBooked, /Next lead/);

// Every state: 44px targets on every button and checkbox label, no em dash.
for (const [name, markup] of Object.entries(html)) {
  assert.doesNotMatch(markup, /—/, `${name}: em dash in rendered copy`);
  for (const button of markup.match(/<button[^>]*>/g) ?? []) {
    assert.match(button, /min-h-1[14]/, `${name}: a button below the 44px target: ${button}`);
  }
  for (const label of markup.match(/<label[^>]*>(?=[^<]*<input[^>]*type="checkbox")/g) ?? []) {
    assert.match(label, /min-h-11/, `${name}: a checkbox label below the 44px target`);
  }
}
const src = readFileSync("components/web-leads/BookMeetPanel.tsx", "utf8");
assert.doesNotMatch(src, /\b(?:text|bg|border|ring|accent)-(?:amber|emerald|green|red|indigo|violet|purple|sky)-\d/, "raw palette class; use semantic tokens");
assert.doesNotMatch(src, /—/, "em dash in the component source");
assert.doesNotMatch(src, /localStorage|sessionStorage/, "client contact details must not be stored in the browser");
assert.match(src, /type="checkbox"/, "confirmations use native, keyboard-accessible checkboxes");
for (const inferred of ["effectiveContactConfirmed", "effectiveClientAgreedToTime", "effectiveHandoffComplete", "effectiveOwnerRequested"]) {
  assert.ok(!src.includes(inferred), `${inferred} must not exist`);
}

console.log("book-meet-panel: OK");
