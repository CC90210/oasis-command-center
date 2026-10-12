"use client";

import type { CliEngine } from "@/lib/ai/agent-engine";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);
const SIGN_IN_COMMAND: Record<Exclude<CliEngine, "gemini">, string> = {
  claude: "claude\n/login",
  codex: "codex login",
};

/**
 * Start the vendor sign-in on one exact paired computer.
 *
 * The overload without pairingId is retained for an older caller during the
 * rollout. AgentEnginePanel always supplies pairingId; that is the only path
 * exposed in Settings now.
 */
export async function startCliSignIn(
  provider: CliEngine,
  pairingIdOrFetch?: string | FetchLike,
  suppliedFetch?: FetchLike,
): Promise<{ ok: true; text: string; jobId?: string; command?: string } | { ok: false; text: string; command?: string }> {
  if (provider === "gemini") {
    return { ok: false, text: "Gemini CLI personal sign-in is not supported. Choose a Google API key instead." };
  }
  const pairingId = typeof pairingIdOrFetch === "string" ? pairingIdOrFetch : null;
  const fetchImpl = typeof pairingIdOrFetch === "function" ? pairingIdOrFetch : suppliedFetch ?? defaultFetch;
  const fallbackCommand = SIGN_IN_COMMAND[provider];
  try {
    const response = await fetchImpl("/api/bridge/cli-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, ...(pairingId ? { pairing_id: pairingId } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      job_id?: unknown;
      command?: unknown;
      message?: unknown;
      instructions?: unknown;
      output?: unknown;
    };
    const command = typeof body.command === "string" && body.command.trim() ? body.command.trim() : fallbackCommand;
    const message =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : pairingId
          ? `On the selected computer, run: ${command}`
          : `On your paired computer, run: ${command}`;
    const instructions = typeof body.instructions === "string" && body.instructions.trim() ? ` ${body.instructions.trim()}` : "";
    const output = typeof body.output === "string" && body.output.trim() ? `\n\n${body.output.trim()}` : "";
    const jobId = typeof body.job_id === "string" && body.job_id.trim() ? body.job_id.trim() : null;
    if (!response.ok || body.ok === false) return { ok: false, text: message + instructions + output, command };
    return {
      ok: true,
      text: message + instructions + output,
      ...(jobId ? { jobId } : {}),
      ...(typeof body.command === "string" ? { command } : {}),
    };
  } catch {
    return {
      ok: false,
      text: `${pairingId ? "On the selected computer" : "On your paired computer"}, run: ${fallbackCommand}`,
      command: fallbackCommand,
    };
  }
}

/**
 * Compatibility mount only. Runtime inventory, repair and Connect now live in
 * AgentEnginePanel so Settings has one source of truth and one device target.
 */
export function LocalCliProvidersCard(_props: { serverBridgeOnline: boolean | null; isAgentsOwner: boolean }) {
  return null;
}
