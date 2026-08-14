/**
 * tests/rep-line-isolation.test.ts — three accounts, three wires.
 *
 * Adon, 2026-08-13: "There are three separate wires for three separate
 * TextTorrent accounts... we need to have each of them using their own numbers
 * not all of them using one number. That defeats the entire purpose."
 *
 * resolveDripSmsIdentity had THREE separate paths that collapsed a rep onto the
 * admin wire whenever that rep had no live number: admin's live pool, admin's
 * static entry via `reg[repKey] || reg.admin`, and the tenant Default Business
 * Number. All three "worked", which is why nothing ever reported that a rep had
 * no line of their own.
 *
 * It is not only an attribution problem. Each account is separately registered
 * with the carrier, so borrowing a line breaks the sender identity the merchant
 * knows, puts the reply in an inbox the rep cannot see, and concentrates every
 * rep's volume onto one number — which is how a number gets burned.
 *
 * The second rule is the one hard constraint on rotation: rotate as much as you
 * like for new conversations, but a conversation already under way stays on its
 * own line. TextTorrent binds a chat to (contact, from_number), so moving a
 * live thread does not continue it — it starts a second one.
 */

import assert from "node:assert/strict";
import { chooseLine, type LinePick } from "../lib/drips/rep-line-core";

// ── Rotation spreads NEW conversations ────────────────────────────────────
{
  const pool = ["+1111", "+2222", "+3333"];
  const picks = new Set(["lead-a", "lead-b", "lead-c", "lead-d", "lead-e", "lead-f"].map(
    (l) => chooseLine({ pool, leadId: l, sticky: null }).line,
  ));
  assert.ok(picks.size > 1, "a multi-number pool must actually spread new leads across it");
  for (const p of picks) assert.ok(pool.includes(p!), "never invents a number");
}

// ── The same NEW lead is stable while the pool is ─────────────────────────
{
  const pool = ["+1111", "+2222", "+3333"];
  const a = chooseLine({ pool, leadId: "lead-x", sticky: null }).line;
  const b = chooseLine({ pool, leadId: "lead-x", sticky: null }).line;
  assert.equal(a, b);
}

// ── STICKY WINS, even when the hash disagrees ─────────────────────────────
// This is the case the old hash-only pick got wrong. Buying or burning a number
// changes the pool, the modulo re-shuffles, and a lead mid-conversation moves
// to a different line — forking the thread.
{
  const before = ["+1111", "+2222"];
  const started = chooseLine({ pool: before, leadId: "lead-x", sticky: null }).line!;

  // A number is bought; the pool grows. Without stickiness the hash would move.
  const after = ["+1111", "+2222", "+3333", "+4444"];
  const hashOnly = chooseLine({ pool: after, leadId: "lead-x", sticky: null }).line;
  const sticky = chooseLine({ pool: after, leadId: "lead-x", sticky: started });

  assert.equal(sticky.line, started, "an existing conversation stays on its line");
  assert.equal(sticky.reason, "sticky");
  if (hashOnly !== started) {
    // The fixture is only meaningful if the hash really would have moved.
    assert.notEqual(sticky.line, hashOnly, "and that differs from what rotation alone would pick");
  }
}

// ── A sticky line that has been BURNED is abandoned ───────────────────────
// The old line is gone from the pool, so the thread cannot continue there. A
// fresh pick is correct, and it must come from the rep's own pool.
{
  const pool = ["+2222", "+3333"];
  const got = chooseLine({ pool, leadId: "lead-x", sticky: "+1111" });
  assert.ok(pool.includes(got.line!), "falls back into the CURRENT pool");
  assert.equal(got.reason, "rotated");
}

// ── An EMPTY pool is blocked, never borrowed ──────────────────────────────
// The whole point: no line of your own means no send, not somebody else's line.
{
  const got = chooseLine({ pool: [], leadId: "lead-x", sticky: null });
  assert.equal(got.line, null);
  assert.equal(got.reason, "no_line");
}

// ...and a sticky number is not a licence to use a line the rep no longer owns.
{
  const got = chooseLine({ pool: [], leadId: "lead-x", sticky: "+9999" });
  assert.equal(got.line, null, "a remembered number cannot resurrect an empty pool");
  assert.equal(got.reason, "no_line");
}

// ── Single-number pools still work ────────────────────────────────────────
{
  assert.equal(chooseLine({ pool: ["+5555"], leadId: "l", sticky: null }).line, "+5555");
  assert.equal(chooseLine({ pool: ["+5555"], leadId: "l", sticky: "+5555" }).reason, "sticky");
}

// ── Type sanity: the reason is always one of the three ────────────────────
{
  const reasons = new Set<LinePick["reason"]>(["sticky", "rotated", "no_line"]);
  for (const c of [
    chooseLine({ pool: [], leadId: "a", sticky: null }),
    chooseLine({ pool: ["+1"], leadId: "a", sticky: null }),
    chooseLine({ pool: ["+1"], leadId: "a", sticky: "+1" }),
  ]) {
    assert.ok(reasons.has(c.reason));
  }
}

console.log("rep-line-isolation.test.ts — all assertions passed");
