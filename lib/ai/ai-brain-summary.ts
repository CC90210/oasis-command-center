/**
 * lib/ai/ai-brain-summary.ts - the ONE sentence at the top of Settings > AI
 * brain: what answers THIS VIEWER's departments right now, and what answers
 * if that is offline (AI1, Adon: "AI brain must be MY instance and never show
 * CC's info").
 *
 * WHY ITS OWN MODULE. Before this, the page's header named the WORKSPACE
 * engine's row ("Claude Code on your paired computer") even for a viewer who
 * is not that row's owner, so a member whose own account cannot reach that
 * computer read "can't be reached from this account" right under a sentence
 * that called it "yours" -- confusing, and for the AI account fallback, the
 * provider shown ("Google Gemini") never said it was the FALLBACK, not the
 * primary. This composes the SAME signals the existing engine panel and the
 * per-person engine card already read (lib/ai/agent-engine-store.ts
 * readEffectiveEngine, lib/ai/bridge-turn.ts bridgeCallerForSession,
 * lib/ai/workspace-account.ts + lib/ai/department-brain.ts) into one honest
 * sentence, built ONLY from the viewer's own effective choice plus the
 * workspace's fallback account -- never a teammate's row.
 *
 * Read-only. A failed read answers { readFailed: true }, never a guess.
 */
import "server-only";
import { readEffectiveEngine } from "@/lib/ai/agent-engine-store";
import { hasUsableKey, readWorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { departmentBrain, brainLine } from "@/lib/ai/department-brain";
import { getOwnComputers } from "@/lib/queries";
import { bridgeCallerForSession } from "@/lib/ai/bridge-turn";
import { CLI_ENGINE_LABEL } from "@/lib/ai/agent-engine";

export type AiBrainSummary =
  | {
      ok: true;
      /** "Claude Code on CCPC", "Gemini 3.8 Flash (your key)", ... */
      primaryLine: string;
      /** Whether the primary runs on a paired device (cli/local) rather than a cloud account. */
      primaryIsDevice: boolean;
      /** Reachable from THIS viewer's own session right now; null when the primary is a cloud account (the question does not apply). */
      deviceOnline: boolean | null;
      /** The viewer's own most-recently-seen device, when the primary is their own computer. A raw heartbeat timestamp, never a claim of readiness. */
      deviceLastSeenAt: string | null;
      /** "Gemini 3.8 Flash (workspace key)", shown only when the primary is a device and a fallback account is connected. */
      fallbackLine: string | null;
    }
  | { ok: false };

const READ_FAILED: AiBrainSummary = { ok: false };

/** The bridge's own authorize gate; a test seam, like bridgeCallerForSession's own (lib/ai/bridge-turn.ts). */
type BridgeGate = Parameters<typeof bridgeCallerForSession>[1];

export async function loadAiBrainSummary(tenantId: string, authUserId: string, authorize?: BridgeGate): Promise<AiBrainSummary> {
  try {
    const [effective, ownComputers, caller, accountRaw] = await Promise.all([
      readEffectiveEngine(tenantId, authUserId),
      getOwnComputers(tenantId, authUserId),
      bridgeCallerForSession(tenantId, authorize).catch(() => null),
      readWorkspaceAiAccount(tenantId),
    ]);
    const account = hasUsableKey(accountRaw) ? departmentBrain(accountRaw) : null;
    const fallbackLine = account ? `${brainLine(account)} (workspace key)` : null;
    const reachableFromThisAccount = caller !== null;

    if (effective.source === "person") {
      if (effective.kind === "computer") {
        const own = ownComputers.find((c) => c.claimEnabledAt) ?? ownComputers[0] ?? null;
        return {
          ok: true,
          primaryLine: `Claude Code on ${own?.label ?? "your computer"}`,
          primaryIsDevice: true,
          deviceOnline: reachableFromThisAccount,
          deviceLastSeenAt: own?.lastSeenAt ?? null,
          fallbackLine,
        };
      }
      return {
        ok: true,
        primaryLine: account ? `${brainLine(account)} (workspace key)` : "Your workspace AI account",
        primaryIsDevice: false,
        deviceOnline: null,
        deviceLastSeenAt: null,
        fallbackLine: null,
      };
    }
    // effective.source === "workspace": nobody has chosen for themselves, so
    // the workspace default answers. It may be a computer that belongs to
    // someone else (the workspace's agents owner) -- named plainly as the
    // WORKSPACE's, never "yours".
    const engine = effective.engine;
    if (engine.kind === "api") {
      return {
        ok: true,
        primaryLine: account ? `${brainLine(account)} (workspace key)` : "Your workspace AI account",
        primaryIsDevice: false,
        deviceOnline: null,
        deviceLastSeenAt: null,
        fallbackLine: null,
      };
    }
    const label = engine.kind === "cli" ? CLI_ENGINE_LABEL[engine.cli] : engine.model;
    return {
      ok: true,
      primaryLine: `${label} on the workspace's paired computer`,
      primaryIsDevice: true,
      deviceOnline: reachableFromThisAccount,
      // Not this viewer's own device: no heartbeat to show without reading
      // another person's row, which this module never does.
      deviceLastSeenAt: null,
      fallbackLine,
    };
  } catch (err) {
    console.error("[ai-brain-summary.load]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return READ_FAILED;
  }
}
