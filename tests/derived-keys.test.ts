/**
 * tests/derived-keys.test.ts - HKDF-SHA256 (lib/crypto/derived-keys.ts), the
 * ONE secret (AUTH_SESSION_SECRET) every O4 bearer derives from, under three
 * distinct labels (mcp, run, inferJob) so a leak of one derived key reveals
 * neither the master key nor the other derived keys.
 *
 * Run: node --conditions=react-server --import tsx tests/derived-keys.test.ts
 */
import assert from "node:assert/strict";

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  const mod = await import("../lib/crypto/derived-keys");
  const { hkdfSha256, deriveKey, derivedKidDisabled, MCP_DERIVED_KID, DERIVED_KEY_LABELS } = mod;

  await check("RFC 5869 SHA-256 test case 1: the raw HKDF primitive matches the official vector (truncated to 32 bytes)", async () => {
    // https://www.rfc-editor.org/rfc/rfc5869 Appendix A.1 (SHA-256).
    const ikm = Uint8Array.from(Array(22).fill(0x0b));
    const salt = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
    const info = Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
    // The official L=42 OKM, truncated to 32 bytes: T(1) does not depend on
    // the requested length, so this is a true positive, not a coincidence.
    const expectedFirst32Hex = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf";
    const okm = await hkdfSha256(ikm, salt, info, 32);
    const hex = Array.from(okm)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert.equal(hex, expectedFirst32Hex);
  });

  await check("hkdfSha256 refuses a length outside 1..255*32", async () => {
    await assert.rejects(() => hkdfSha256("ikm", "salt", "info", 0));
    await assert.rejects(() => hkdfSha256("ikm", "salt", "info", 255 * 32 + 1));
  });

  const env = { AUTH_SESSION_SECRET: "derived-keys-test-master-secret-at-least-32-chars-long" };

  await check("deriveKey is deterministic for the same label", async () => {
    const a = await deriveKey(DERIVED_KEY_LABELS.mcp, { env });
    const b = await deriveKey(DERIVED_KEY_LABELS.mcp, { env });
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  await check("different labels give different keys (mcp vs run vs inferJob)", async () => {
    const mcp = await deriveKey(DERIVED_KEY_LABELS.mcp, { env });
    const run = await deriveKey(DERIVED_KEY_LABELS.run, { env });
    const inferJob = await deriveKey(DERIVED_KEY_LABELS.inferJob, { env });
    assert.notEqual(mcp, run);
    assert.notEqual(mcp, inferJob);
    assert.notEqual(run, inferJob);
  });

  await check("a different master secret gives a different derived key for the same label", async () => {
    const a = await deriveKey(DERIVED_KEY_LABELS.mcp, { env });
    const b = await deriveKey(DERIVED_KEY_LABELS.mcp, { env: { AUTH_SESSION_SECRET: "a-completely-different-master-secret-32-chars-min" } });
    assert.notEqual(a, b);
  });

  await check("deriveKey throws closed when AUTH_SESSION_SECRET is missing or too short", async () => {
    await assert.rejects(() => deriveKey(DERIVED_KEY_LABELS.mcp, { env: {} }));
    await assert.rejects(() => deriveKey(DERIVED_KEY_LABELS.mcp, { env: { AUTH_SESSION_SECRET: "short" } }));
  });

  await check("deriveKey throws closed on an empty label", async () => {
    await assert.rejects(() => deriveKey("", { env }));
  });

  await check("MCP_DERIVED_KID is the fixed 'd1' kid the design names", () => {
    assert.equal(MCP_DERIVED_KID, "d1");
  });

  await check("derivedKidDisabled reads the emergency switch; unset means derivation stays ON", () => {
    assert.equal(derivedKidDisabled({}), false);
    assert.equal(derivedKidDisabled({ OASIS_MCP_DERIVED_KID_DISABLED: "" }), false);
    assert.equal(derivedKidDisabled({ OASIS_MCP_DERIVED_KID_DISABLED: "1" }), true);
    assert.equal(derivedKidDisabled({ OASIS_MCP_DERIVED_KID_DISABLED: "true" }), true);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
