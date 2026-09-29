/**
 * components/os/department/channel.ts — can this department's channel answer?
 *
 * The channel is components/agents/AgentChat.tsx posting to /api/agents/chat.
 * That route refuses a turn for three reasons it only reports AFTER the owner
 * has typed a message: an unknown workspace slug (400), an agent it cannot find
 * (404), or no AI provider — no workspace key and not an operator (412). This
 * asks the same three questions up front, with the route's own rules, so the
 * header can say "Not connected" and the owner is told what to connect instead
 * of typing into a box that will fail.
 *
 * Mirrors app/api/agents/chat/route.ts; if that route's provider rule changes,
 * change it here too.
 */

import "server-only";
import type { OsDepartment } from "@/lib/os/departments";
import { getAgentBySlug } from "@/lib/agents/loader";
import { manifestExists } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { getServiceSupabase } from "@/lib/supabase-server";
import { departmentChannelFor } from "./config";
import type { OsViewer } from "./viewer";

export type ChannelState =
  | {
      kind: "ready";
      /** The slug /api/agents/chat accepts for this workspace. */
      tenantSlug: string;
      agentSlug: string;
      greeting: string;
    }
  | {
      kind: "not_connected";
      reason: string;
      /** Where to fix it, when the viewer is the one who can. */
      action: { href: string; label: string } | null;
    };

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
 * The route's provider rule: a workspace `bravo` row in agent_model_config
 * that is enabled and carries a key, or else the operator platform fallback.
 * The fallback uses the SAME verified check as app/api/agents/chat
 * (isPlatformOperatorForAuthUser: alias AND an OASIS owner/admin profile by
 * auth id), so a channel never reads as ready for someone the route refuses.
 * Same query shape as the route (`maybeSingle`) for the workspace row.
 */
async function providerReady(
  tenantId: string,
  authUserId: string | null,
  email: string | null,
): Promise<boolean> {
  if (await isPlatformOperatorForAuthUser(authUserId, email)) return true;
  try {
    const res = await getServiceSupabase()
      .from("agent_model_config")
      .select("enabled, encrypted_api_key")
      .eq("tenant_id", tenantId)
      .eq("agent_key", "bravo")
      .maybeSingle();
    if (res.error) {
      console.error("[os.channel.provider]", res.error);
      return false;
    }
    const row = res.data as { enabled: unknown; encrypted_api_key: string | null } | null;
    return !!row && (row.enabled === true || row.enabled === 1) && !!row.encrypted_api_key;
  } catch (err) {
    console.error("[os.channel.provider]", err);
    return false;
  }
}

/**
 * The two workspace-wide halves of "can a channel answer": a slug the chat
 * route accepts, and an AI provider. One read for every channel on a page (the
 * AI Team roster asks once for all departments).
 */
export async function workspaceChatReadiness(
  viewer: OsViewer,
): Promise<{ slug: string | null; provider: boolean }> {
  const [slug, provider] = await Promise.all([
    workspaceChatSlug(viewer.surface.tenantId),
    providerReady(viewer.surface.tenantId, viewer.authUserId, viewer.email),
  ]);
  return { slug, provider };
}

export async function resolveChannelState(dept: OsDepartment, viewer: OsViewer): Promise<ChannelState> {
  const binding = departmentChannelFor(dept.key, { oasis: viewer.oasis });
  if (binding.kind === "unavailable") {
    return { kind: "not_connected", reason: binding.reason, action: null };
  }
  const owner = viewer.surface.persona === "founder";
  const tenantId = viewer.surface.tenantId;
  const [{ slug, provider }, agent] = await Promise.all([
    workspaceChatReadiness(viewer),
    getAgentBySlug(binding.agentSlug, tenantId),
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
  if (!provider) {
    return {
      kind: "not_connected",
      reason: owner
        ? "No AI provider is connected for this workspace yet. Connect one and every department channel can answer."
        : "No AI provider is connected for this workspace yet. An owner or admin can connect one in Settings.",
      action: owner ? { href: "/settings#providers", label: "Connect a provider" } : null,
    };
  }
  return { kind: "ready", tenantSlug: slug, agentSlug: agent.slug, greeting: binding.greeting };
}
