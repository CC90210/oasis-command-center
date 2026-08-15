/**
 * redactUrlKeyParams must cover the token name THIS app's database actually uses.
 *
 * The list was `key|api_key|apikey|access_token`. libSQL and Turso use
 * `authToken`, and this app runs on Turso — so a driver error like
 *
 *   SQLITE_UNKNOWN: connect to libsql://….turso.io?authToken=eyJhbGciOi… failed
 *
 * passed through untouched. I had already written in a commit message that
 * redactAll handled it, on the strength of the helper existing rather than of
 * running it. redactSecrets only catches the token when it matches an env value
 * verbatim, which is not guaranteed in every runtime.
 *
 * Widening a redaction list is strictly safe — it can only redact more — but it
 * is security code with several callers, so the old coverage is pinned here too.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { redactAll, redactUrlKeyParams } from "../lib/secret-redaction";

test("libSQL/Turso authToken is redacted", () => {
  const out = redactAll(
    "SQLITE_UNKNOWN: connect to libsql://bravo.turso.io?authToken=eyJhbGciOiJFZERTQSJ9.secret failed",
  );
  assert.match(out, /authToken=\[REDACTED\]/);
  assert.doesNotMatch(out, /eyJhbGciOiJFZERTQSJ9/, "the token itself must not survive");
});

test("snake_case and bare token variants are redacted", () => {
  assert.match(redactAll("https://x.turso.io?auth_token=abc123def456"), /auth_token=\[REDACTED\]/);
  assert.match(redactAll("https://api.example.com/v1?token=sk_live_9f8e7d6c"), /token=\[REDACTED\]/);
});

test("the original coverage still works — widening must not regress it", () => {
  for (const p of ["key", "api_key", "apikey", "access_token"]) {
    const out = redactUrlKeyParams(`https://x.com/a?${p}=SUPERSECRETVALUE123`);
    assert.match(out, new RegExp(`${p}=\\[REDACTED\\]`), `${p} stopped being redacted`);
    assert.doesNotMatch(out, /SUPERSECRETVALUE123/);
  }
});

test("redaction stops at the parameter boundary", () => {
  const out = redactUrlKeyParams("https://x.com?authToken=abc123&campaign_id=keep-me");
  assert.match(out, /campaign_id=keep-me/, "the next param must survive");
  assert.doesNotMatch(out, /abc123/);
});

test("text with no token is returned unchanged", () => {
  const plain = "UNIQUE constraint failed: cold_outreach_recipients.contact_address";
  assert.equal(redactUrlKeyParams(plain), plain);
});

test("PII is NOT redacted — which is why driver text stays off the wire", () => {
  // This is the load-bearing negative. redactAll scrubs SECRETS; a UNIQUE
  // violation names the conflicting VALUE, and on cold_outreach_recipients that
  // is contact_address — a lead's email or phone. The cold-outreach route
  // therefore returns counts only and keeps messages server-side. If this
  // assertion ever flips, that reasoning needs revisiting, not deleting.
  const withPii = "UNIQUE constraint failed: contact_address = 'someone@example.com'";
  assert.match(redactAll(withPii), /someone@example\.com/);
});

test("null and undefined are safe", () => {
  assert.equal(redactUrlKeyParams(null), "");
  assert.equal(redactUrlKeyParams(undefined), "");
  assert.equal(redactAll(null), "");
});
