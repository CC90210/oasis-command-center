/**
 * tests/agent-config-provider-switch.test.ts — a saved key belongs to its
 * provider (S4-09).
 *
 * `/model gpt-5.4` in a chat whose row held an Anthropic key rewrote the row's
 * provider and model and kept the Anthropic key; every department channel
 * reading that row then failed with the provider refusing the key. POST
 * /api/agent-config now refuses a provider change on a row with a key unless
 * the request carries a key for the new provider: 409 provider_mismatch, with
 * the fix in the message. A model change inside the same provider, a switch
 * that brings its key, and a switch on a row with no key all still work.
 *
 * The route runs for real; its three reads (session, database, manifest
 * membership) and the field cipher are stubbed at the module boundary.
 *
 * Run: node --conditions=react-server --import tsx tests/agent-config-provider-switch.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(__dirname, "..");

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type Row = Record<string, unknown>;
let existingRow: Row | null = null;
const writes: Array<{ kind: "update" | "insert"; payload: Row }> = [];
const audits: Row[] = [];

function thenable(result: () => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: existingRow, error: null });
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
  return chain;
}
const service = {
  from(table: string) {
    assert.equal(table, "agent_model_config");
    return {
      select: () => thenable(() => ({ data: existingRow ? [existingRow] : [], error: null })),
      update: (payload: Row) => {
        writes.push({ kind: "update", payload });
        return thenable(() => ({ error: null }));
      },
      insert: async (payload: Row) => {
        writes.push({ kind: "insert", payload });
        return { error: null };
      },
    };
  },
};

stub(join(ROOT, "lib", "team.ts"), {
  getSessionContext: async () => ({ tenantId: "tenant-1", authUserId: "user-1", isOwner: true, teamRole: "owner", adminAccess: true }),
  canManageTeam: () => true,
});
stub(join(ROOT, "lib", "supabase-server.ts"), {
  getServiceSupabase: () => service,
  getAuthedSupabase: async () => ({
    rpc: async (_name: string, args: Row) => {
      audits.push(args);
      return { data: null, error: null };
    },
  }),
});
stub(join(ROOT, "lib", "manifest", "tenant-scope.ts"), { isTenantChatAgent: async () => true });
stub(join(ROOT, "lib", "field-encryption.ts"), { encryptField: (value: string) => `enc:${value}` });

async function main() {
  const { POST } = await import("../app/api/agent-config/route");
  const { NextRequest } = await import("next/server");
  const post = async (body: Row) => {
    const res = await POST(
      new NextRequest("http://localhost/api/agent-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Row };
  };
  const reset = (row: Row | null) => {
    existingRow = row;
    writes.length = 0;
    audits.length = 0;
  };
  const anthropicRow = { id: "row-1", provider: "anthropic", encrypted_api_key: "enc:sk-ant-saved" };

  // ── The failure that shipped: /model to another provider, no key ──────────
  reset(anthropicRow);
  const refused = await post({ agent_key: "bravo", provider: "openai", model: "gpt-5.4" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "provider_mismatch");
  assert.equal(refused.body.message, "Paste an OpenAI Direct key to switch providers.");
  assert.deepEqual(writes, [], "the row is untouched: the Anthropic key is not stranded under provider=openai");
  assert.deepEqual(audits, [], "a refusal is not an update");

  // The article follows the provider's name.
  reset(anthropicRow);
  assert.equal((await post({ agent_key: "bravo", provider: "google", model: "gemini-2.5-pro" })).body.message, "Paste a Google Gemini key to switch providers.");
  reset({ ...anthropicRow, provider: "openai" });
  assert.equal((await post({ agent_key: "bravo", provider: "anthropic", model: "claude-sonnet-4-6" })).body.message, "Paste an Anthropic Direct key to switch providers.");

  // ── A switch that brings its key is a real switch ─────────────────────────
  reset(anthropicRow);
  const switched = await post({ agent_key: "bravo", provider: "openai", model: "gpt-5.4", api_key: "sk-proj-new" });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "update");
  assert.equal(writes[0].payload.provider, "openai");
  assert.equal(writes[0].payload.model, "gpt-5.4");
  assert.equal(writes[0].payload.encrypted_api_key, "enc:sk-proj-new", "the new provider's key replaces the old one");

  // ── A model change inside the provider keeps the key ──────────────────────
  reset(anthropicRow);
  const sameProvider = await post({ agent_key: "bravo", provider: "anthropic", model: "claude-opus-4-7" });
  assert.equal(sameProvider.status, 200, JSON.stringify(sameProvider.body));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.model, "claude-opus-4-7");
  assert.equal("encrypted_api_key" in writes[0].payload, false, "no key in the payload: the saved one stays");

  // ── No key on the row: nothing to strand, so the switch goes through ──────
  reset({ id: "row-2", provider: "anthropic", encrypted_api_key: null });
  const keyless = await post({ agent_key: "bravo", provider: "openai", model: "gpt-5.4" });
  assert.equal(keyless.status, 200, JSON.stringify(keyless.body));
  assert.equal(writes[0]?.payload.provider, "openai");

  // ── No row at all: an insert, as before ───────────────────────────────────
  reset(null);
  const fresh = await post({ agent_key: "bravo", provider: "openai", model: "gpt-5.4", api_key: "sk-proj-first" });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(writes[0]?.kind, "insert");

  // ── Unknown provider and model are still refused before anything is read ──
  reset(anthropicRow);
  assert.equal((await post({ agent_key: "bravo", provider: "nope", model: "x" })).status, 400);
  assert.equal((await post({ agent_key: "bravo", provider: "openai", model: "" })).status, 400);

  // ── The chat's /model picker is pinned the same way ───────────────────────
  const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
  assert.match(widget, /function modelPickerProvider\(configs: AgentConfig\[\], agentKey: string\): string \| null/);
  assert.match(widget, /return row\?\.has_key \? row\.provider : null;/, "a row with a key pins the picker to its provider");
  assert.match(widget, /const pinned = modelPickerProvider\(configs, agent\);\s+const configuredProviders/, "the picker's candidates are pinned");
  assert.match(widget, /if \(pinned && provider !== pinned\) \{/, "/model <id> refuses another provider's model");

  console.log("agent-config-provider-switch: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
