import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.CHAT_RESUME_HMAC_KEY = "engine-fallback-test-key-that-is-long-enough-123456";

let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.stack : String(error)}`);
  }
}

async function main() {
  const fallback = await import("../lib/ai/engine-fallback-dispatch");
  const nowMs = Date.parse("2026-10-12T15:00:00.000Z");
  const base = {
    tenantId: "tenant-a",
    userId: "user-a",
    agentKey: "bravo",
    pairingId: "pairing-a",
    engineKind: "subscription" as const,
    engineName: "codex",
    reason: "computer_offline" as const,
    conversationId: "18b8518c-d82b-4d88-a371-129bf21b8737",
    nowMs,
  };

  console.log("engine-fallback-dispatch:");

  await check("a signed fallback is bound to its requester, agent, tenant and exact engine", () => {
    const minted = fallback.mintEngineFallbackDispatch(base);
    assert.ok(minted);
    const verified = fallback.verifyEngineFallbackDispatch({
      stateHeader: minted.stateHeader,
      signature: minted.signature,
      userId: base.userId,
      agentKey: base.agentKey,
      nowMs: nowMs + 1_000,
    });
    assert.deepEqual(verified, minted.state);
    assert.equal(fallback.engineFallbackAuditReason(verified), "engine_unreachable:codex+computer_offline");
    assert.match(fallback.engineFallbackReplyLabel(verified), /uses workspace API credits/);
    assert.match(fallback.engineFallbackReplyLabel(verified), /no other computer was used/);
  });

  await check("another user or agent cannot replay the signed fallback", () => {
    const minted = fallback.mintEngineFallbackDispatch(base);
    assert.ok(minted);
    assert.equal(fallback.verifyEngineFallbackDispatch({
      stateHeader: minted.stateHeader,
      signature: minted.signature,
      userId: "user-b",
      agentKey: base.agentKey,
      nowMs,
    }), null);
    assert.equal(fallback.verifyEngineFallbackDispatch({
      stateHeader: minted.stateHeader,
      signature: minted.signature,
      userId: base.userId,
      agentKey: "maven",
      nowMs,
    }), null);
  });

  await check("tampered, expired and non-UUID fallback instructions fail closed", () => {
    const minted = fallback.mintEngineFallbackDispatch(base);
    assert.ok(minted);
    const tampered = Buffer.from(JSON.stringify({ ...minted.state, tenant_id: "tenant-b" }), "utf8").toString("base64url");
    assert.equal(fallback.verifyEngineFallbackDispatch({
      stateHeader: tampered,
      signature: minted.signature,
      userId: base.userId,
      agentKey: base.agentKey,
      nowMs,
    }), null);
    assert.equal(fallback.verifyEngineFallbackDispatch({
      stateHeader: minted.stateHeader,
      signature: minted.signature,
      userId: base.userId,
      agentKey: base.agentKey,
      nowMs: nowMs + 121_000,
    }), null);
    assert.equal(fallback.mintEngineFallbackDispatch({ ...base, conversationId: "not-a-uuid" }), null);
  });

  await check("the cloud route forces workspace-only accounting, cloud-only tools and a truthful persisted label", () => {
    const route = readFileSync(join(process.cwd(), "app", "api", "chat", "route.ts"), "utf8");
    const auth = readFileSync(join(process.cwd(), "lib", "chat-auth.ts"), "utf8");
    const widget = readFileSync(join(process.cwd(), "components", "ChatWidget.tsx"), "utf8");
    assert.match(route, /accountPolicy: "workspace_only"/);
    assert.match(route, /fallbackDispatch \|\| payload\.tool_routing === "cloud_only"/);
    assert.match(route, /meterWithFallbackReason/);
    assert.match(route, /let assistantText = fallbackReplyLabel/);
    assert.match(route, /if \(!fallbackDispatch\) send\("session"/);
    assert.match(auth, /if \(workspaceOnly\)[\s\S]*workspace_api_not_configured/);
    assert.match(auth, /workspaceOnly \|\| !userOverride\.data\?\.encrypted_api_key/);
    assert.match(route, /ownedChatSessionId\(requestedSessionId, tenantId, user\.id, agentKey\)/, "a fallback cannot append under another agent's session");
    assert.match(widget, /setTabId\(mintTabId\(\)\);\s*setMessages\(seedMessagesForAgent\(agent, welcomeMessages\)\)/, "switching agents mints a new bridge conversation id");
  });

  console.log(`engine-fallback-dispatch: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
