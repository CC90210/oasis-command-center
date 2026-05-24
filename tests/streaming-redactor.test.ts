/**
 * StreamingRedactor + createRedactingSseSend test — guards the
 * subtle invariants that Codex caught three P1 bugs around. These
 * are the kind of failures next build won't catch (the redactor
 * compiles fine while leaking secrets); only behavioral tests
 * actually pin the contract.
 *
 * Run: npm run test:streaming-redactor
 *
 * Conventions follow the other tests in this directory:
 * `tsx tests/<name>.test.ts` with node:assert/strict, no jest /
 * vitest.
 */
import assert from "node:assert/strict";
import { StreamingRedactor, type VaultSecret } from "@/lib/secret-redaction";
import { createRedactingSseSend } from "@/lib/chat-sse-helpers";

let passed = 0;
let failed = 0;
const fail = (label: string, err: unknown) => {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  FAIL  ${label}\n         ${msg}`);
};
const ok = (label: string) => {
  passed++;
  console.log(`  ok    ${label}`);
};
const test = (label: string, fn: () => void) => {
  try {
    fn();
    ok(label);
  } catch (err) {
    fail(label, err);
  }
};

// Test secrets — both at least MIN_REDACTABLE_LEN (12) chars so the
// redactor actually scrubs them; shorter values are ignored as too-
// likely false positives.
const SECRET_LONG: VaultSecret = {
  key: "STRIPE_SECRET",
  value: "sk_live_abcdefghijklmnopqrstuvwxyz1234567890",
};
const SECRET_SHORT_OK: VaultSecret = {
  key: "API_TOKEN",
  value: "tok_12345678abc",
};
const SECRET_TOO_SHORT: VaultSecret = {
  key: "PIN",
  value: "1234",
};

// ============================================================================
// StreamingRedactor — behavioral invariants
// ============================================================================

test("single chunk containing full secret → no leak, tag in flush", () => {
  const r = new StreamingRedactor([SECRET_LONG]);
  // The redactor scrubs the secret as soon as it sees the full
  // value, BUT the hold-back (maxSecretLen-1 chars) can hold back
  // part of the replacement tag too. The contract we actually care
  // about: no part of the original secret value appears in ANY
  // chunk, and the combined output (after flush) contains the tag.
  const out = r.push(`Hello ${SECRET_LONG.value} world world world world world`);
  assert.ok(!out.includes(SECRET_LONG.value), `secret leaked in push: ${out}`);
  const combined = out + r.flush();
  assert.ok(combined.includes("[REDACTED:STRIPE_SECRET]"), `tag missing in combined: ${combined}`);
  assert.ok(!combined.includes(SECRET_LONG.value), `secret leaked after flush: ${combined}`);
});

test("secret spans two chunks → caught after second push", () => {
  const r = new StreamingRedactor([SECRET_LONG]);
  const half = Math.floor(SECRET_LONG.value.length / 2);
  const a = SECRET_LONG.value.slice(0, half);
  const b = SECRET_LONG.value.slice(half);
  // First push: just the first half. Should be entirely held back
  // (it's the prefix of a possibly-completing secret).
  const out1 = r.push(`Here it is: ${a}`);
  assert.ok(!out1.includes(a), `first half should be held: emitted=${out1}`);
  // Second push: the rest of the secret + a long tail to force flush.
  const out2 = r.push(`${b} and then more text and more text and more text`);
  const combined = out1 + out2;
  assert.ok(combined.includes("[REDACTED:STRIPE_SECRET]"), `cross-chunk scrub failed: ${combined}`);
  assert.ok(!combined.includes(SECRET_LONG.value), `secret leaked across chunks: ${combined}`);
});

test("length-DESC ordering — longer secret wins over shorter substring", () => {
  // Construct two secrets where the SHORTER is a substring of the
  // LONGER, so naive iteration would half-replace.
  const longer: VaultSecret = {
    key: "LONGER",
    value: "prefix_token_12345678_suffix",
  };
  const shorter: VaultSecret = { key: "SHORTER", value: "token_12345678" };
  const r = new StreamingRedactor([shorter, longer]); // arg order shouldn't matter
  const out = r.push(`Value is ${longer.value} and end and end and end and end`);
  assert.ok(out.includes("[REDACTED:LONGER]"), `expected LONGER tag: ${out}`);
  assert.ok(!out.includes("[REDACTED:SHORTER]"), `SHORTER fired on substring: ${out}`);
  assert.ok(!out.includes(longer.value), `longer leaked: ${out}`);
});

test("secret shorter than MIN_REDACTABLE_LEN ignored", () => {
  const r = new StreamingRedactor([SECRET_TOO_SHORT]);
  const out = r.push(`Code is ${SECRET_TOO_SHORT.value} and other text`);
  // 4-char "1234" stays in the output — it's below the threshold so
  // the redactor doesn't try to match it (would shred normal text).
  assert.ok(out.includes(SECRET_TOO_SHORT.value), `too-short value was scrubbed: ${out}`);
});

test("empty secrets array → push is pass-through", () => {
  const r = new StreamingRedactor([]);
  const out = r.push("Anything goes when there are no secrets to hide.");
  assert.equal(out, "Anything goes when there are no secrets to hide.");
});

test("flush returns and clears buffer", () => {
  const r = new StreamingRedactor([SECRET_SHORT_OK]);
  // Push something shorter than maxSecretLen so it stays held.
  const out1 = r.push("tail");
  assert.equal(out1, "", "short push should be fully held");
  const tail = r.flush();
  assert.equal(tail, "tail", "flush should release the held tail");
  // Second flush → empty (buffer was cleared).
  assert.equal(r.flush(), "");
});

test("hold-back length matches longest secret minus one", () => {
  const r = new StreamingRedactor([SECRET_LONG]);
  // Push a string whose length equals exactly the hold-back amount.
  const holdBack = SECRET_LONG.value.length - 1;
  const padding = "x".repeat(holdBack);
  const out = r.push(padding);
  // All held — nothing emitted yet.
  assert.equal(out, "", `should hold all ${holdBack} chars; got: ${out}`);
  // One more char → first char flushes (everything before the hold).
  const out2 = r.push("y");
  assert.equal(out2, "x", `expected single 'x' release; got: ${out2}`);
});

test("flush is safe to call multiple times in a row", () => {
  const r = new StreamingRedactor([SECRET_LONG]);
  r.push("short");
  assert.equal(r.flush(), "short");
  assert.equal(r.flush(), "");
  assert.equal(r.flush(), "");
});

// ============================================================================
// createRedactingSseSend — wiring contract
// ============================================================================

type CapturedEvent = { event: string; data: unknown };

function makeCapturingController(): {
  controller: { enqueue: (chunk: Uint8Array) => void };
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const decoder = new TextDecoder();
  return {
    controller: {
      enqueue(chunk: Uint8Array) {
        const text = decoder.decode(chunk);
        // SSE frames look like: `event: <name>\ndata: <json>\n\n`
        const match = text.match(/^event: (.+)\ndata: (.+)\n\n$/);
        if (!match) throw new Error(`unexpected SSE frame: ${text}`);
        events.push({ event: match[1], data: JSON.parse(match[2]) });
      },
    },
    events,
  };
}

test("delta events route through the redactor", () => {
  const { controller, events } = makeCapturingController();
  const { send } = createRedactingSseSend(controller, [SECRET_LONG]);
  send("delta", { text: `Here ${SECRET_LONG.value} done done done done done done done done done` });
  const allText = events
    .filter((e) => e.event === "delta")
    .map((e) => (e.data as { text: string }).text)
    .join("");
  assert.ok(allText.includes("[REDACTED:STRIPE_SECRET]"), `expected redaction in: ${allText}`);
  assert.ok(!allText.includes(SECRET_LONG.value), `secret leaked in stream: ${allText}`);
});

test("non-delta events emit as-is", () => {
  const { controller, events } = makeCapturingController();
  const { send } = createRedactingSseSend(controller, []);
  send("session", { session_id: "s-123" });
  send("usage", { input_tokens: 10, output_tokens: 20 });
  assert.deepEqual(events[0], { event: "session", data: { session_id: "s-123" } });
  assert.deepEqual(events[1], { event: "usage", data: { input_tokens: 10, output_tokens: 20 } });
});

test("done event flushes the held tail", () => {
  const { controller, events } = makeCapturingController();
  const { send } = createRedactingSseSend(controller, [SECRET_LONG]);
  // Push something short enough to stay held.
  send("delta", { text: "tail" });
  const deltasBeforeDone = events.filter((e) => e.event === "delta");
  assert.equal(deltasBeforeDone.length, 0, "tail should still be held");
  send("done", {});
  const deltasAfter = events.filter((e) => e.event === "delta");
  assert.equal(deltasAfter.length, 1, "done should have flushed the tail");
  assert.equal((deltasAfter[0].data as { text: string }).text, "tail");
  // done event itself should be emitted AFTER the flush.
  const doneIdx = events.findIndex((e) => e.event === "done");
  const flushedDeltaIdx = events.findIndex((e) => e.event === "delta");
  assert.ok(flushedDeltaIdx < doneIdx, "flushed delta must arrive before done");
});

test("tool_use_pending arms pause flag → done does NOT flush", () => {
  const { controller, events } = makeCapturingController();
  const { send, isPaused } = createRedactingSseSend(controller, [SECRET_LONG]);
  // Push a held tail.
  send("delta", { text: "secret_prefix_held_back_in_buffer" });
  // Pause → arms the flag.
  send("tool_use_pending", { tool_use_id: "t-1", name: "send_email", input: {} });
  assert.equal(isPaused(), true, "pause flag should be armed");
  // done → should NOT flush because we paused for resume.
  send("done", {});
  const deltas = events.filter((e) => e.event === "delta");
  assert.equal(deltas.length, 0, `expected zero deltas (held tail dropped on pause); got ${deltas.length}`);
});

test("mid-stream tool events do NOT flush the held tail", () => {
  const { controller, events } = makeCapturingController();
  const { send } = createRedactingSseSend(controller, [SECRET_LONG]);
  send("delta", { text: "tail_that_should_stay_buffered" });
  send("cloud_tool_call", { name: "list_records", input: {} });
  send("cloud_tool_result", { name: "list_records", ok: true });
  const deltasBefore = events.filter((e) => e.event === "delta");
  assert.equal(deltasBefore.length, 0, "tool events must not flush the buffer");
  // Now done — should flush.
  send("done", {});
  const deltasAfter = events.filter((e) => e.event === "delta");
  assert.equal(deltasAfter.length, 1, "done flushes the buffer");
});

test("error event flushes the held tail (same as done)", () => {
  const { controller, events } = makeCapturingController();
  const { send } = createRedactingSseSend(controller, [SECRET_LONG]);
  send("delta", { text: "tail" });
  send("error", { message: "stream blew up" });
  const flushedDeltas = events.filter((e) => e.event === "delta");
  assert.equal(flushedDeltas.length, 1, "error should flush");
});

test("isPaused returns false until tool_use_pending fires", () => {
  const { controller } = makeCapturingController();
  const { send, isPaused } = createRedactingSseSend(controller, []);
  assert.equal(isPaused(), false);
  send("delta", { text: "hello" });
  send("usage", { input_tokens: 5, output_tokens: 5 });
  assert.equal(isPaused(), false);
  send("tool_use_pending", { tool_use_id: "t-1" });
  assert.equal(isPaused(), true);
});

// ============================================================================
// Report
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
