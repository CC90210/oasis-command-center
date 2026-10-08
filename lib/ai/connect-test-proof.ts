/**
 * lib/ai/connect-test-proof.ts - proof that a pasted AI key was just tested,
 * so the save route does not have to test it a second time.
 *
 * WHY (PR #535 review, R5-L3). The real one-token key test ran only in the
 * browser: the Settings dialog asked /api/agent-config/test-connection first
 * and saved only when the provider answered, but /api/agent-config/bulk-provider
 * itself saved any 8-400 character string an owner or admin posted. A direct
 * request, a script or a second client could save an untested or dead key, and
 * the card then read Connected over it.
 *
 * Now the save route tests the key itself (lib/agents/provider-probe.ts),
 * unless the request carries one of these proofs: short-lived, signed by
 * test-connection after ITS test, and bound to the workspace, the person, the
 * provider, the model and a hash of the exact key. The browser flow tests
 * once, as before; anything else is tested by the route. A proof says one of:
 *   passed       the provider answered the one-token test;
 *   unreachable  the provider was down or slow (5xx or no answer in time),
 *                which says nothing about the key: the route saves it only
 *                when the request also says save_anyway (the dialog's "Save
 *                anyway", offered only then).
 *
 * The key is never in the proof, only its SHA-256. The HMAC key is the field
 * encryption passphrase every key save already needs (no new secret), under
 * its own label. No passphrase: nothing is signed and nothing is accepted, so
 * the route tests the key itself.
 */
import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ConnectTestVerdict = "passed" | "unreachable";

/** How long a test speaks for its key: long enough to finish the dialog. */
export const CONNECT_TEST_PROOF_TTL_MS = 10 * 60_000;

const LABEL = "oasis-ai-key-test.v1";

export type ConnectTestSubject = {
  tenantId: string;
  userId: string;
  provider: string;
  model: string;
  apiKey: string;
};

function signingPassphrase(): string | null {
  const passphrase = process.env.BRAVO_FIELD_ENCRYPTION_KEY;
  return passphrase && passphrase.length >= 16 ? passphrase : null;
}

function mac(passphrase: string, s: ConnectTestSubject, verdict: ConnectTestVerdict, expiresAt: number): Buffer {
  const keyHash = createHash("sha256").update(s.apiKey, "utf8").digest("base64url");
  const body = [LABEL, s.tenantId, s.userId, s.provider, s.model, keyHash, verdict, String(expiresAt)].join("|");
  return createHmac("sha256", passphrase).update(body, "utf8").digest();
}

/** A proof of this test's verdict, or null when nothing can be signed. */
export function signConnectTest(subject: ConnectTestSubject, verdict: ConnectTestVerdict, now: number = Date.now()): string | null {
  const passphrase = signingPassphrase();
  if (!passphrase) return null;
  const expiresAt = now + CONNECT_TEST_PROOF_TTL_MS;
  return `v1.${verdict}.${expiresAt}.${mac(passphrase, subject, verdict, expiresAt).toString("base64url")}`;
}

/**
 * The verdict a proof carries for exactly this workspace, person, provider,
 * model and key, or null: absent, malformed, expired, signed for anything
 * else, or no passphrase to check it with.
 */
export function readConnectTest(proof: unknown, subject: ConnectTestSubject, now: number = Date.now()): ConnectTestVerdict | null {
  if (typeof proof !== "string") return null;
  const parts = proof.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const verdict = parts[1];
  if (verdict !== "passed" && verdict !== "unreachable") return null;
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + CONNECT_TEST_PROOF_TTL_MS) return null;
  const passphrase = signingPassphrase();
  if (!passphrase) return null;
  const expected = mac(passphrase, subject, verdict, expiresAt);
  const got = Buffer.from(parts[3], "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected) ? verdict : null;
}
