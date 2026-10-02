/**
 * components/os/department/channel.ts — can this department's channel answer?
 *
 * The channel is components/agents/AgentChat.tsx posting to /api/agents/chat.
 * That route refuses a turn for three reasons it only reports AFTER the owner
 * has typed a message: a workspace it cannot resolve (400), an agent it cannot
 * find (404), or no AI provider — no workspace key and not an operator (412).
 * This asks the same three questions up front, with the route's own rules, so
 * the header can say "Not connected" and the owner is told what to connect
 * instead of typing into a box that will fail. A question it could not ask (the
 * AI settings read failed) is "Couldn't check", never "Not connected".
 *
 * A key that answers is not the same as a key on file. So a ready channel also
 * carries its LAST TURN (lib/os/channel/turns.ts, recorded by the route): when
 * the provider refused it, the header says "Not working: …" in the same words
 * the channel used (lib/os/channel/outcome.ts), until a turn succeeds again.
 *
 * Mirrors app/api/agents/chat/route.ts; if that route's provider rule changes,
 * change it here too.
 */

import "server-only";
import type { OsDepartment } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";
import { getAgentBySlug } from "@/lib/agents/loader";
import { manifestExists } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { operatorPlatformFallback } from "@/lib/operator-credentials";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { AI_SETTINGS_HREF, channelFailure, departmentChannelKey } from "@/lib/os/channel/outcome";
import { readTurnOutcomes, type TurnOutcomesRead } from "@/lib/os/channel/turns";
import { hasUsableKey, readWorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { departmentChannelFor } from "./config";
import type { OsViewer } from "./viewer";

/**
 * What the last turn in this channel says about it:
 *   ok        no failure on record (or nothing recorded yet)
 *   failed    the last word on this channel was a failure, with its code
 *   unknown   the record could not be read, so "no failure" is not known
 */
export type LastTurn = { kind: "ok" } | { kind: "failed"; code: string } | { kind: "unknown" };

export type ChannelState =
  | {
      kind: "ready";
      /** The department this channel belongs to; the route checks the binding. */
      department: DepartmentKey;
      agentSlug: string;
      greeting: string;
      lastTurn: LastTurn;
      /** Owners/admins: may open AI settings, so failures carry the fix link. */
      canManageAi: boolean;
    }
  | {
      kind: "not_connected";
      reason: string;
      /** Where to fix it, when the viewer is the one who can. */
      action: { href: string; label: string } | null;
    }
  | {
      /** The AI account could not be checked (a failed read), so neither
       *  "ready" nor "not connected" is known. No connect button: sending an
       *  owner to connect an account that may be connected is the lie. */
      kind: "unknown";
      reason: string;
    };

/**
 * The workspace's AI provider, as the route would find it:
 *   ready    a key the route would use
 *   none     no such key (a known answer: the route answers 412)
 *   unknown  the read failed (the route answers 503 config_unavailable)
 */
export type ProviderReadiness = "ready" | "none" | "unknown";

/**
 * The slug the chat route and the builder accept for this workspace, or null.
 * resolveOwnedSlug is the records API's own answer; manifestExists is the chat
 * route's first check. Shared with the AI Team page (builder + custom-agent
 * links need the same slug).
 */
export async function workspaceChatSlug(tenantId: string): Promise<string | null> {
  try {
    const slug = await resolveOwnedSlug(tenantId);
    if (!slug) return null;
    return (await manifestExists(slug)) ? slug.toLowerCase() : null;
  } catch (err) {
    console.error("[os.channel.slug]", err);
    return null;
  }
}

/**
 * The route's provider rule, exactly:
 *   - the workspace's AI account (lib/ai/workspace-account.ts, the one row
 *     lib/os/department-agent.ts reads; never a teammate's personal key),
 *     enabled, with a key; or
 *   - the verified operator (isPlatformOperatorForAuthUser: alias AND an OASIS
 *     owner/admin profile by auth id) WHEN a platform key is configured. Being
 *     the operator is not a key: with no platform key the route answers 412,
 *     so the channel is not ready either.
 * A failed read is `unknown`, never "none": the route answers it with 503
 * config_unavailable, not 412, and the header must agree with the route.
 */
async function providerReady(
  tenantId: string,
  authUserId: string | null,
  email: string | null,
): Promise<ProviderReadiness> {
  try {
    if (hasUsableKey(await readWorkspaceAiAccount(tenantId))) return "ready";
  } catch (err) {
    console.error("[os.channel.provider]", err);
    return "unknown";
  }
  return operatorPlatformFallback() !== null && (await isPlatformOperatorForAuthUser(authUserId, email))
    ? "ready"
    : "none";
}

/**
 * The two workspace-wide halves of "can a channel answer": a slug the chat
 * route accepts, and an AI provider. One read for every channel on a page (the
 * AI Team roster asks once for all departments).
 */
export async function workspaceChatReadiness(
  viewer: OsViewer,
): Promise<{ slug: string | null; provider: ProviderReadiness }> {
  const [slug, provider] = await Promise.all([
    workspaceChatSlug(viewer.surface.tenantId),
    providerReady(viewer.surface.tenantId, viewer.authUserId, viewer.email),
  ]);
  return { slug, provider };
}

/**
 * The workspace's recorded last turns, one read per page (the AI Team roster
 * judges every lead from the same read).
 */
export async function readWorkspaceTurns(tenantId: string): Promise<TurnOutcomesRead> {
  if (!tursoConfigured()) return { ok: true, value: [] };
  return readTurnOutcomes(getTursoClient(), tenantId);
}

/**
 * A channel's last turn, by the key the route records it under
 * (departmentChannelKey, or agentChannelKey for a direct agent chat), judged
 * against the whole workspace's (lib/os/channel/outcome.ts channelFailure,
 * which leaves "no AI account connected" to providerReady). A table not yet
 * migrated reads as "nothing recorded"; any other failed read is `unknown`,
 * never "ok".
 */
export function lastTurnOn(read: TurnOutcomesRead, channelKey: string): LastTurn {
  if (!read.ok) return read.reason === "table_missing" ? { kind: "ok" } : { kind: "unknown" };
  const failure = channelFailure(read.value, channelKey);
  return failure ? { kind: "failed", code: failure.code } : { kind: "ok" };
}

/** This department's last turn (lastTurnOn, on its department channel key). */
export function lastTurnFrom(read: TurnOutcomesRead, department: DepartmentKey): LastTurn {
  return lastTurnOn(read, departmentChannelKey(department));
}

export async function resolveChannelState(dept: OsDepartment, viewer: OsViewer): Promise<ChannelState> {
  // Who leads it: the workspace's manifest (config.ts departmentChannelFor).
  const binding = departmentChannelFor(dept.key, { oasis: viewer.oasis, manifest: viewer.manifest });
  if (binding.kind === "unavailable") {
    return { kind: "not_connected", reason: binding.reason, action: null };
  }
  const owner = viewer.surface.persona === "founder";
  const tenantId = viewer.surface.tenantId;
  const [{ slug, provider }, agent, turns] = await Promise.all([
    workspaceChatReadiness(viewer),
    getAgentBySlug(binding.agentSlug, tenantId),
    readWorkspaceTurns(tenantId),
  ]);
  if (!slug) {
    return {
      kind: "not_connected",
      reason: "This workspace's agent settings are not set up yet, so its channels cannot answer.",
      action: null,
    };
  }
  if (!agent) {
    return {
      kind: "not_connected",
      reason: "This department's AI teammate could not be found.",
      action: null,
    };
  }
  if (provider === "unknown") {
    return {
      kind: "unknown",
      reason: "We could not check this workspace's AI account just now, so this channel cannot start. Refresh to try again.",
    };
  }
  if (provider === "none") {
    return {
      kind: "not_connected",
      reason: owner
        ? "No AI account is connected for this workspace yet. Connect one and every department channel can answer."
        : "No AI account is connected for this workspace yet. An owner or admin can connect one in Settings.",
      action: owner ? { href: AI_SETTINGS_HREF, label: "Connect an AI account" } : null,
    };
  }
  return {
    kind: "ready",
    department: dept.key,
    agentSlug: agent.slug,
    greeting: binding.greeting,
    lastTurn: lastTurnFrom(turns, dept.key),
    canManageAi: owner,
  };
}
