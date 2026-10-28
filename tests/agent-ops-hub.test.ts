/**
 * tests/agent-ops-hub.test.ts - Admin > Agent ops: Runs and Inbox, merged, honest about delivery (2026-10-28).
 *
 * Pinned here:
 *   1. deliveryStateOf says only what a note's record proves, in one line, at an exact instant: read,
 *      dismissed, delivered, waiting (online, offline, an old bridge, no computer, couldn't check), and
 *      the notes no computer carries (an agent's note, an agent with no reader, a note from before);
 *   2. keyChanges lists an action's changed top-level keys, capped, with long values shortened;
 *   3. the pages: operator-gated first, PageFrame, the two tabs, the composer offering only agents with
 *      a reader, values scrubbed in the trace; /runs and /inbox redirect here; one Admin rail row;
 *   4. the post route writes the database only, as the operator, and marks a directive relayable only
 *      for an agent with a reader; the ping accepts agent_inbox_v1.
 *
 * Run: node --conditions=react-server --import tsx tests/agent-ops-hub.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

async function main(): Promise<void> {
  const { deliveryStateOf, keyChanges, agentName, DELIVERY_STARTED_AT } = await import("../lib/os/agent-ops");
  const { RELAY_RECIPIENTS, isRelayRecipient } = await import("../lib/agent-inbox-db");

  const NOW = Date.parse("2026-10-28T12:00:00.000Z");
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const note = (over: Record<string, unknown> = {}) => ({
    to_agent: "bravo",
    created_at: minutesAgo(10),
    read_at: null,
    relay_eligible: 1,
    delivered_at: null,
    delivered_label: null,
    acked_at: null,
    read_via: null,
    ...over,
  });
  const mac = { label: "CC's Mac", lastSeenAt: minutesAgo(1), deliversNotes: true };
  const key = (over: Record<string, unknown>, computer: unknown = mac) =>
    deliveryStateOf(note(over) as never, computer as never, NOW).key;

  // 1. One state per record.
  assert.equal(key({}), "waiting", "eligible, undelivered, computer online");
  assert.match(deliveryStateOf(note() as never, mac, NOW).text, /CC's Mac to pick it up, within a minute/);
  assert.equal(key({}, { ...mac, lastSeenAt: minutesAgo(60) }), "waiting_offline");
  assert.match(deliveryStateOf(note() as never, { ...mac, lastSeenAt: minutesAgo(60) }, NOW).text, /offline since/);
  assert.equal(key({}, { ...mac, lastSeenAt: null }), "waiting_offline");
  assert.equal(key({}, { ...mac, deliversNotes: false }), "old_bridge");
  assert.equal(key({}, null), "no_computer");
  assert.equal(deliveryStateOf(note() as never, undefined, NOW).key, "waiting_unknown", "a failed computer read says it could not check");
  assert.equal(key({ delivered_at: minutesAgo(3), delivered_label: "CC's Mac" }), "delivered");
  assert.match(deliveryStateOf(note({ delivered_at: minutesAgo(3), delivered_label: "CC's Mac" }) as never, mac, NOW).text, /Delivered to CC's Mac · 3 min ago, not read yet/);
  assert.equal(key({ delivered_at: minutesAgo(3), acked_at: minutesAgo(1), read_at: minutesAgo(1), read_via: "agent" }), "read");
  assert.match(deliveryStateOf(note({ acked_at: minutesAgo(1), read_at: minutesAgo(1), read_via: "agent" }) as never, mac, NOW).text, /^Read by Bravo/);
  assert.equal(key({ read_at: minutesAgo(2), read_via: "dashboard" }), "dismissed");
  assert.equal(key({ read_at: minutesAgo(2), read_via: "cloud_chat" }), "read_cloud");
  assert.equal(key({ read_at: minutesAgo(2), read_via: null }), "read_earlier", "a note read before read_via existed");
  assert.equal(key({ to_agent: "cc", relay_eligible: 0 }), "for_you");
  assert.equal(key({ relay_eligible: 0 }), "agent_note", "a relayable agent that the operator did not relay to");
  assert.equal(key({ to_agent: "aura", relay_eligible: 0 }), "no_reader");
  assert.match(deliveryStateOf(note({ to_agent: "aura", relay_eligible: 0 }) as never, mac, NOW).text, /No computer delivers to Aura/);
  assert.equal(key({ relay_eligible: 0, created_at: "2026-10-01T00:00:00.000Z" }), "before_delivery");
  assert.ok(Date.parse(DELIVERY_STARTED_AT) <= NOW);
  assert.equal(key({ relay_eligible: true }), "waiting", "libSQL may hand the flag back as a boolean");
  console.log("  ok    delivery states");

  assert.deepEqual([...RELAY_RECIPIENTS], ["bravo", "atlas", "maven", "broadcast"]);
  assert.equal(isRelayRecipient(" Maven "), true);
  assert.equal(isRelayRecipient("aura"), false, "Aura has no local reader yet");
  assert.equal(agentName("broadcast"), "every agent");
  assert.equal(agentName("cc"), "You");
  assert.equal(agentName("someone-new"), "someone-new");
  console.log("  ok    recipients and names");

  // 2. The action diff.
  {
    const { changes, more } = keyChanges({ stage: "assigned", name: "Acme", gone: 1 }, { stage: "qualified", name: "Acme", added: true });
    assert.deepEqual(changes, [
      { key: "added", change: "added", before: null, after: "true" },
      { key: "gone", change: "removed", before: "1", after: null },
      { key: "stage", change: "changed", before: "assigned", after: "qualified" },
    ]);
    assert.equal(more, 0);
    assert.deepEqual(keyChanges("old", "new").changes, [{ key: "value", change: "changed", before: "old", after: "new" }]);
    assert.deepEqual(keyChanges(undefined, undefined).changes, []);
    const many = keyChanges({}, Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i])), 12);
    assert.equal(many.changes.length, 12);
    assert.equal(many.more, 3);
    const long = keyChanges({}, { note: "x".repeat(500) }).changes[0];
    assert.equal(long.after!.length, 120);
    assert.ok(long.after!.endsWith("…"));
    console.log("  ok    key changes");
  }

  // 3. The pages and the routing.
  for (const rel of ["app/agent-ops/page.tsx", "app/agent-ops/trace/page.tsx"]) {
    const src = read(rel);
    const body = src.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)$/);
    assert.ok(body, `${rel}: default export`);
    const first = body![1].split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
    assert.equal(first, "await requireOperator();", `${rel}: the gate comes first`);
    assert.match(src, /<PageFrame/, `${rel}: PageFrame`);
    assert.match(src, /<AgentOpsTabs active="(handoffs|trace)" \/>/, `${rel}: the two tabs`);
  }
  assert.match(read("app/agent-ops/page.tsx"), /<AgentInboxComposer recipients=\{RELAY_RECIPIENTS\}/, "the composer offers only agents with a reader");
  assert.match(read("app/agent-ops/page.tsx"), /deliveryStateOf\(m, computer, now\)/);
  const trace = read("app/agent-ops/trace/page.tsx");
  assert.ok((trace.match(/redactAll\(/g) || []).length >= 3, "summaries and every before/after value are scrubbed");
  assert.ok(existsSync(join(ROOT, "app/agent-ops/loading.tsx")));
  assert.ok(!existsSync(join(ROOT, "app/runs/page.tsx")) && !existsSync(join(ROOT, "app/inbox/page.tsx")), "the old pages are gone");
  const { OS_REDIRECTS } = await import("../lib/os/redirects");
  assert.equal(OS_REDIRECTS["/runs"], "/agent-ops/trace");
  assert.equal(OS_REDIRECTS["/inbox"], "/agent-ops");
  const { OS_NAV_CATALOG } = await import("../lib/os/nav");
  const adminRows = OS_NAV_CATALOG.filter((e) => e.section === "admin").map((e) => e.href);
  assert.ok(adminRows.includes("/agent-ops") && !adminRows.includes("/runs") && !adminRows.includes("/inbox"), "one Admin row");
  assert.match(read("components/ChatWidget.tsx"), /href="\/agent-ops\/trace"/, "the chat's history link follows the move");
  console.log("  ok    pages and routing");

  // 4. The routes.
  const postRoute = read("app/api/inbox/post/route.ts");
  assert.doesNotMatch(postRoute, /from "@\/lib\/agent-inbox-fs"/, "no filesystem write: the Worker has no disk");
  assert.match(postRoute, /from: "cc",/, "the sender is the operator, whatever the body says");
  assert.match(postRoute, /relayEligible: isRelayRecipient\(to\),/);
  assert.match(postRoute, /if \(!\(await isPlatformOperatorForAuthUser\(user\.id, user\.email\)\)\)/);
  assert.doesNotMatch(read("app/api/inbox/mark-read/route.ts"), /from "@\/lib\/agent-inbox-fs"/);
  assert.match(read("app/api/chat/route.ts"), /markReadDb\(tenantId, id, "cloud_chat"\)/, "a cloud chat's read is labelled");
  assert.match(read("app/api/bridge/ping/route.ts"), /"coding_harness_task_v1", AGENT_INBOX_PROTOCOL\]/, "the ping accepts agent_inbox_v1");
  const { AGENT_INBOX_PROTOCOL } = await import("../lib/agent-inbox-types");
  assert.equal(AGENT_INBOX_PROTOCOL, "agent_inbox_v1");
  console.log("  ok    routes");

  console.log("agent-ops-hub: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
