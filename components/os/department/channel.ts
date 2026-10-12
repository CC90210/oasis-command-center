/**
 * components/os/department/channel.ts — can this department's channel answer?
 *
 * DepartmentChannel posts to /api/os/runs. Both this header and that route use
 * resolveRunSession, so personal inheritance, provider matching, the exact
 * paired computer, approval, claim protocol/capacity, probe proof and explicit
 * API fallback consent are one decision. The header cannot say Ready for a run
 * that the execution path will refuse. A question it could not ask (a settings
 * or runtime read failed) is "Couldn't check", never "Not connected".
 *
 * A key that answers is not the same as a key on file. So a ready channel also
 * carries its LAST TURN (lib/os/channel/turns.ts, recorded by the route): when
 * the provider refused it, the header says "Not working: …" in the same words
 * the channel used (lib/os/channel/outcome.ts), until a turn succeeds again.
 *
 * Custom teammates still use /api/agents/chat, which supports primary API
 * engines only; workspaceChatReadiness exposes that answer separately.
 */

import "server-only";
import type { OsDepartment } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";
import { getAgentBySlug } from "@/lib/agents/loader";
import { manifestExists } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { AI_SETTINGS_HREF, channelFailure, departmentChannelKey } from "@/lib/os/channel/outcome";
import { readTurnOutcomes, type TurnOutcomesRead } from "@/lib/os/channel/turns";
import { readWorkspaceAccountChangedAt } from "@/lib/ai/workspace-account";
import { brainLine, departmentBrain, type DepartmentBrain } from "@/lib/ai/department-brain";
import { bridgeEngineLine, harnessEngineLine, spendFor, type AgentEngineChoice, type EngineLabel, type EngineSpend } from "@/lib/ai/agent-engine";
import { harnessForDepartment } from "@/lib/admin/harness-targets";
import { resolveRunSession } from "@/lib/os/runs/session";
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
      /**
       * What answers in this channel: the workspace AI account's provider and
       * model, as Settings > AI brain shows and switches them
       * (lib/ai/department-brain.ts). Owners and admins only, the people who
       * choose it there; null for anyone else, or when the selected paired
       * runtime answers instead of an API account.
       */
      brain?: DepartmentBrain | null;
      /**
       * What powers this channel (lib/ai/agent-engine.ts): the API account, or
       * an AI app / local model on the paired computer, and whose credits or
       * plan it spends. Owners and admins only; null for anyone else.
       */
      engine?: ChannelEngine | null;
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
 * Whether the canonical route can execute the selected exact runtime/API:
 *   ready    the selected engine passed every execution gate
 *   none     a known pairing/runtime/account gate refused it
 *   unknown  a required read failed, so readiness cannot be claimed
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

/** The effective canonical choice and whether its exact paired runtime, rather
 * than an API fallback, will answer. */
type EngineRead = { chosen: AgentEngineChoice; reachable: boolean } | null;
type NotReadyKind = "account" | "runtime" | null;

function latestChangedAt(...values: Array<string | null | undefined>): string | null {
  let latest: { value: string; time: number } | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && (!latest || time > latest.time)) latest = { value, time };
  }
  return latest?.value ?? null;
}

async function providerReady(
  viewer: OsViewer,
  department: DepartmentKey,
): Promise<{
  readiness: ProviderReadiness;
  brain: DepartmentBrain | null;
  accountChangedAt: string | null;
  engine: ChannelEngine | null;
  engineRead: EngineRead;
  directAgentReadiness: ProviderReadiness;
  notReadyKind: NotReadyKind;
}> {
  const tenantId = viewer.surface.tenantId;
  const authUserId = viewer.authUserId;
  if (!authUserId) {
    return {
      readiness: "unknown",
      brain: null,
      accountChangedAt: null,
      engine: null,
      engineRead: null,
      directAgentReadiness: "unknown",
      notReadyKind: null,
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveRunSession>>;
  try {
    // This is the execution resolver in read-only mode: personal inheritance,
    // provider matching, exact pairing ownership, approval, protocol, busy /
    // offline state, runtime heartbeat, durable probe and explicit fallback
    // consent are therefore identical to a real send. It never enqueues work.
    resolved = await resolveRunSession({
      department,
      inspectOnly: true,
      actor: {
        tenantId,
        user: { id: authUserId, email: viewer.email },
        profile: {
          team_role: viewer.surface.teamRole,
          is_owner: viewer.surface.persona === "founder",
          admin_access: viewer.surface.persona === "founder",
        },
        viewer,
        engineUserId: authUserId,
        operatorName: null,
      },
    });
  } catch (err) {
    console.error("[os.channel.provider]", err);
    return {
      readiness: "unknown",
      brain: null,
      accountChangedAt: null,
      engine: null,
      engineRead: null,
      directAgentReadiness: "unknown",
      notReadyKind: null,
    };
  }
  if (!resolved.ok) {
    const unavailable = resolved.status >= 500;
    const accountFailure = resolved.error === "agent_not_configured" || resolved.error === "engine_snapshot_unavailable";
    return {
      readiness: unavailable ? "unknown" : "none",
      brain: null,
      accountChangedAt: null,
      engine: null,
      engineRead: null,
      directAgentReadiness: unavailable ? "unknown" : "none",
      notReadyKind: unavailable ? null : accountFailure ? "account" : "runtime",
    };
  }

  const session = resolved.session;
  // An armed workspace_api fallback sets both apiEngineChoice and
  // computerDispatch while the computer is healthy. The exact computer is
  // authoritative until fallbackReason says fallback actually activated.
  if (session.computerDispatch) {
    const dispatch = session.computerDispatch;
    const chosen: AgentEngineChoice = dispatch.engineKind === "cli"
      ? { kind: "cli", cli: dispatch.engineName as "claude" | "codex" | "gemini", pairingId: dispatch.pairingId, fallback: dispatch.fallback }
      : { kind: "local", model: dispatch.engineName, pairingId: dispatch.pairingId, fallback: dispatch.fallback };
    return {
      readiness: "ready",
      brain: null,
      accountChangedAt: session.engineChangedAt ?? null,
      engine: channelEngine(chosen, true, null),
      engineRead: { chosen, reachable: true },
      directAgentReadiness: "none",
      notReadyKind: null,
    };
  }

  const brain = session.apiAccountSnapshot ? departmentBrain(session.apiAccountSnapshot) : null;
  const fallbackActive = session.fallbackReason !== null && session.fallbackFrom !== null;
  if (fallbackActive && brain) {
    const changedAt = latestChangedAt(session.engineChangedAt, await readWorkspaceAccountChangedAt(tenantId));
    return {
      readiness: "ready",
      brain,
      accountChangedAt: changedAt,
      engine: channelEngine(session.fallbackFrom!, false, brain),
      engineRead: { chosen: session.fallbackFrom!, reachable: false },
      directAgentReadiness: "none",
      notReadyKind: null,
    };
  }
  if (session.apiEngineChoice && brain) {
    const changedAt = latestChangedAt(session.engineChangedAt, await readWorkspaceAccountChangedAt(tenantId));
    return {
      readiness: "ready",
      brain,
      accountChangedAt: changedAt,
      engine: channelEngine(session.apiEngineChoice, false, brain),
      engineRead: { chosen: session.apiEngineChoice, reachable: false },
      directAgentReadiness: "ready",
      notReadyKind: null,
    };
  }
  return {
    readiness: "none",
    brain: null,
    accountChangedAt: session.engineChangedAt ?? null,
    engine: null,
    engineRead: null,
    directAgentReadiness: "none",
    notReadyKind: "runtime",
  };
}

/**
 * What a channel header says powers it (owners and admins only), in the same
 * words a reply's footer uses (lib/ai/agent-engine.ts): the line, whose credits
 * or plan it spends, and, when the chosen engine on the paired computer cannot
 * be reached, that the API account answers instead. PURE.
 */
export function channelEngine(
  chosen: AgentEngineChoice,
  reachable: boolean,
  brain: DepartmentBrain | null,
  /** The department's agent harness (lib/admin/harness-targets.ts), when the channel has one. */
  harnessLabel: string | null = null,
): ChannelEngine {
  if (chosen.kind !== "api" && reachable) {
    return { line: harnessLabel ? harnessEngineLine(chosen, harnessLabel) : bridgeEngineLine(chosen), spend: spendFor(chosen), note: null };
  }
  const apiLine = brain ? brainLine(brain) : "the selected workspace API account";
  const spend: EngineSpend = "api_credits";
  if (chosen.kind !== "api") {
    return {
      line: apiLine,
      spend,
      note: `${bridgeEngineLine(chosen)} could not answer, so your explicitly enabled workspace API fallback answers.`,
    };
  }
  return { line: apiLine, spend, note: null };
}

export type ChannelEngine = EngineLabel;

/**
 * The two workspace-wide halves of "can a channel answer": a slug the chat
 * route accepts, and a canonical engine that can execute. One read for every
 * channel on a page (the AI Team roster asks once for all departments).
 * `brain` is what answers (the account's provider and model,
 * lib/ai/department-brain.ts).
 * `directAgentProvider` is deliberately separate because custom direct chats
 * cannot execute device engines yet. `accountChangedAt` is the latest selected
 * engine/account change and retires failures for a configuration no longer in
 * use (lastTurnOn).
 */
export async function workspaceChatReadiness(viewer: OsViewer, department: DepartmentKey = "chief_of_staff"): Promise<{
  slug: string | null;
  provider: ProviderReadiness;
  brain: DepartmentBrain | null;
  accountChangedAt: string | null;
  engine: ChannelEngine | null;
  /** The choice and whether the paired computer answers this person (null: not read). */
  engineRead: EngineRead;
  /** Readiness for /agents/<slug>, which supports only a primary API engine. */
  directAgentProvider: ProviderReadiness;
  notReadyKind: NotReadyKind;
}> {
  const [slug, ready] = await Promise.all([
    workspaceChatSlug(viewer.surface.tenantId),
    providerReady(viewer, department),
  ]);
  return {
    slug,
    provider: ready.readiness,
    brain: ready.brain,
    accountChangedAt: ready.accountChangedAt,
    engine: ready.engine,
    engineRead: ready.engineRead,
    directAgentProvider: ready.directAgentReadiness,
    notReadyKind: ready.notReadyKind,
  };
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
 * which leaves current engine readiness to providerReady). A table not yet
 * migrated reads as "nothing recorded"; any other failed read is `unknown`,
 * never "ok". A failure recorded before the selected engine or API account
 * last changed (`accountChangedAt`) is about a configuration the channels no
 * longer use, and is not shown (channelFailure).
 */
export function lastTurnOn(read: TurnOutcomesRead, channelKey: string, accountChangedAt: string | null = null): LastTurn {
  if (!read.ok) return read.reason === "table_missing" ? { kind: "ok" } : { kind: "unknown" };
  const failure = channelFailure(read.value, channelKey, accountChangedAt);
  return failure ? { kind: "failed", code: failure.code } : { kind: "ok" };
}

/** This department's last turn (lastTurnOn, on its department channel key). */
export function lastTurnFrom(read: TurnOutcomesRead, department: DepartmentKey, accountChangedAt: string | null = null): LastTurn {
  return lastTurnOn(read, departmentChannelKey(department), accountChangedAt);
}

export async function resolveChannelState(dept: OsDepartment, viewer: OsViewer): Promise<ChannelState> {
  // Who leads it: the workspace's manifest (config.ts departmentChannelFor).
  const binding = departmentChannelFor(dept.key, { oasis: viewer.oasis, manifest: viewer.manifest });
  if (binding.kind === "unavailable") {
    return { kind: "not_connected", reason: binding.reason, action: null };
  }
  const owner = viewer.surface.persona === "founder";
  const tenantId = viewer.surface.tenantId;
  const [{ slug, provider, brain, accountChangedAt, engine: workspaceEngine, engineRead, notReadyKind }, agent, turns] = await Promise.all([
    workspaceChatReadiness(viewer, dept.key),
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
    const runtime = notReadyKind === "runtime";
    return {
      kind: "not_connected",
      reason: runtime
        ? owner
          ? "The selected computer runtime is not ready for agents. Repair or test it in AI brain."
          : "The selected computer runtime is not ready for agents. An owner or admin can repair it in Settings."
        : owner
          ? "The selected workspace API account is not connected or does not match this engine. Connect the matching account in AI brain."
          : "The selected workspace API account is not connected or does not match this engine. An owner or admin can fix it in Settings.",
      action: owner
        ? { href: AI_SETTINGS_HREF, label: runtime ? "Open AI brain" : "Connect an AI account" }
        : null,
    };
  }
  return {
    kind: "ready",
    department: dept.key,
    agentSlug: agent.slug,
    greeting: binding.greeting,
    lastTurn: lastTurnFrom(turns, dept.key, accountChangedAt),
    canManageAi: owner,
    brain: owner ? brain : null,
    // Which engine and which agent harness answers this department (OASIS:
    // the department's harness on the paired computer, lib/admin/harness-targets.ts).
    engine: owner ? engineForChannel(dept.key, viewer.oasis, engineRead, brain, workspaceEngine) : null,
  };
}

/** A channel's header line: the workspace's engine, with this department's harness named when it runs in one. */
function engineForChannel(
  departmentKey: DepartmentKey,
  oasis: boolean,
  read: EngineRead,
  brain: DepartmentBrain | null,
  fallback: ChannelEngine | null,
): ChannelEngine | null {
  const target = oasis ? harnessForDepartment(departmentKey) : null;
  if (!read || !target || !read.reachable) return fallback;
  return channelEngine(read.chosen, true, brain, target.departments);
}
