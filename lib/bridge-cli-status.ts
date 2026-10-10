export const CLI_INVENTORY_SERVICE = "local_ai_clis";
export const CLI_INVENTORY_MAX_AGE_MS = 5 * 60 * 1000;

const INSTALL_URLS = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
} as const;

export type CliProvider = keyof typeof INSTALL_URLS;

export type CliInventoryMetadata = {
  providers?: Partial<
    Record<
      CliProvider,
      {
        installed?: unknown;
        authenticated?: unknown;
        version?: unknown;
        /** Newer bridges: "ok", "unsupported" (the vendor refuses this sign-in), or why a check could not finish ("timeout", "error"). */
        probe?: unknown;
      }
    >
  >;
};

export type CliStatusInfo = {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  install_hint_url: string;
  /**
   * Whether the computer's checks for this app FINISHED (see cliStatusState).
   * false when the bridge said a check timed out or failed, or when the
   * snapshot itself shows the sign-in check never ran.
   */
  checked: boolean;
  /**
   * The vendor refuses this computer's sign-in for this app (probe "unsupported":
   * Google ended Gemini CLI on a personal Google sign-in). A finished verdict
   * that signing in again cannot change. Absent on a snapshot from an older reader.
   */
  unsupported?: boolean;
};

/**
 * What a CLI's snapshot proves, and nothing more (CC, 2026-10-09: "it says
 * Claude Code needs auth and Codex CLI is not installed, and then Gemini CLI
 * needs auth. This is incorrect").
 *
 * WHY THE OLD WORDS WERE WRONG. The paired bridge (bravo_cli/bridge_tools.py
 * _tool_cli_status) runs `<cli> --version` with a 5-second limit and checks
 * the sign-in ONLY when that version call succeeds; on Windows the npm-installed
 * Gemini CLI takes about 8 s to print its version, so it is reported
 * installed:true, authenticated:false, version:null although it is signed in.
 * Codex is judged by a health script given 10 s that takes about 10.7 s, and
 * any failure there is reported installed:false. So "installed, not signed in"
 * with NO version means the sign-in was never checked: it is unknown, never
 * "Needs auth". (The bridge-side fix, longer limits and a sign-in check that
 * does not wait on the version, is Bravo's: see the PR.)
 *
 *   ready          installed and signed in
 *   needs_sign_in  installed, version read, and the sign-in check said no
 *   unknown        installed, but a check did not finish (no version, or the
 *                  bridge said timeout/error): it may well be signed in
 *   not_detected   the computer did not report it installed (it may be
 *                  missing, or its check may have timed out on an older bridge)
 *   unsupported    installed, and the vendor refuses this sign-in (probe
 *                  "unsupported"): a FINISHED check, never "Ready", and not
 *                  "Needs sign-in" either (signing in again does not help)
 */
export type CliState = "ready" | "needs_sign_in" | "unknown" | "not_detected" | "unsupported";

export function cliStatusState(info: Pick<CliStatusInfo, "installed" | "authenticated" | "checked"> & { unsupported?: boolean }): CliState {
  if (info.installed && info.unsupported) return "unsupported";
  if (info.installed && info.authenticated) return "ready";
  if (!info.installed) return "not_detected";
  return info.checked ? "needs_sign_in" : "unknown";
}

/**
 * Each app's REAL sign-in, checked against the installed apps on CC's PC on
 * 2026-10-09 (`claude auth --help`, `codex login --help`, `gemini --help`):
 *   - Claude Code 2.1.270 has `claude auth login` (it opens Anthropic's
 *     sign-in page; `claude auth status` checks it);
 *   - Codex 0.146.0 has `codex login` (`codex login status` checks it); it has
 *     no `auth` subcommand, so `codex auth login` would start a chat;
 *   - Gemini CLI 0.63.0 has no sign-in subcommand: run `gemini` and choose
 *     "Sign in with Google" (or type /auth).
 * Shown on every card that is not ready, and sent with every Connect answer
 * (app/api/bridge/cli-auth), so a sign-in the bridge cannot start is one
 * command away.
 */
export const CLI_SIGN_IN: Record<CliProvider, { label: string; command: string }> = {
  claude: { label: "Claude Code", command: "claude auth login" },
  codex: { label: "Codex", command: "codex login" },
  gemini: { label: "Gemini CLI", command: 'gemini   (then choose "Sign in with Google", or type /auth)' },
};

export function isSignInProvider(v: unknown): v is CliProvider {
  return v === "claude" || v === "codex" || v === "gemini";
}

export const CLI_STATE_LABEL: Record<CliState, string> = {
  ready: "Ready",
  needs_sign_in: "Needs sign-in",
  unknown: "Sign-in not confirmed",
  not_detected: "Not detected",
  unsupported: "Not supported on this sign-in",
};

/** Why an app is "unsupported" on this sign-in, in plain words (the same sentence the bridge's run error maps to, lib/os/channel/outcome.ts). */
export const CLI_UNSUPPORTED_DETAIL = "Google no longer lets Gemini CLI run on a personal Google sign-in. Pick Claude Code or Codex, or use an AI account.";

/** The same, for any app: only Gemini is refused today; another app's refusal gets a general sentence. */
export function cliUnsupportedDetail(provider: CliProvider): string {
  return provider === "gemini"
    ? CLI_UNSUPPORTED_DETAIL
    : "The app's maker does not allow this sign-in on this computer. Pick another app, or use an AI account.";
}

export type CliStatusSnapshot = Record<CliProvider, CliStatusInfo>;

export type NormalizedCliSnapshot =
  | { ok: true; data: CliStatusSnapshot }
  | { ok: false; reason: "missing" | "stale" | "invalid_inventory" };

function metadataObject(value: unknown): CliInventoryMetadata | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as CliInventoryMetadata;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as CliInventoryMetadata)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads one computer's `providers` block; null when any app's record is missing or malformed. */
function parseProviders(rawProviders: unknown): CliStatusSnapshot | null {
  if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) return null;
  const record = rawProviders as NonNullable<CliInventoryMetadata["providers"]>;
  const providers = {} as CliStatusSnapshot;
  for (const provider of Object.keys(INSTALL_URLS) as CliProvider[]) {
    const raw = record[provider];
    if (!raw || typeof raw !== "object") return null;
    const rawVersion = raw.version;
    const version = typeof rawVersion === "string" && rawVersion.trim() ? rawVersion.trim().slice(0, 160) : null;
    const installed = raw.installed === true;
    const authenticated = raw.authenticated === true;
    // A check that did not finish: the bridge said so, or the sign-in check
    // could not have run (installed, not signed in, and no version read).
    const probeFailed = raw.probe === "timeout" || raw.probe === "error";
    const unsupported = installed && raw.probe === "unsupported";
    providers[provider] = {
      installed,
      authenticated,
      version,
      install_hint_url: INSTALL_URLS[provider],
      // "unsupported" is a verdict, not a check that failed to finish.
      checked: unsupported || (!probeFailed && !(installed && !authenticated && version === null)),
      unsupported,
    };
  }
  return providers;
}

function freshPingMs(lastPingAt: string | null | undefined, nowMs: number): "missing" | "stale" | number {
  if (!lastPingAt) return "missing";
  const pingMs = Date.parse(lastPingAt);
  if (!Number.isFinite(pingMs)) return "stale";
  if (pingMs > nowMs || nowMs - pingMs > CLI_INVENTORY_MAX_AGE_MS) return "stale";
  return pingMs;
}

export function normalizeCliSnapshot(
  metadataValue: unknown,
  lastPingAt: string | null | undefined,
  nowMs: number = Date.now(),
): NormalizedCliSnapshot {
  const fresh = freshPingMs(lastPingAt, nowMs);
  if (typeof fresh === "string") return { ok: false, reason: fresh };
  const providers = parseProviders(metadataObject(metadataValue)?.providers);
  return providers ? { ok: true, data: providers } : { ok: false, reason: "invalid_inventory" };
}

/**
 * ONE ROW, MANY COMPUTERS (CC, 2026-10-09: two paired computers, "Ready" one
 * minute and "Needs sign-in" the next). integrations_health keeps one
 * local_ai_clis row per workspace member, and each computer's heartbeat used to
 * REPLACE it, so Settings showed whichever computer reported last. Each
 * computer now writes only its own entry under metadata.machines.<pairing id>
 * (app/api/bridge/ping, one SQL statement), and every reader shows one line
 * per computer.
 */
export type CliMachineEntry = { label?: unknown; seen_at?: unknown; checked_at?: unknown; providers?: unknown };

export type CliMachineSnapshot = {
  /** bridge_pairings.id; null for a row an older bridge wrote (providers at the top level). */
  id: string | null;
  /** The pairing's label (CCPC (Windows)); null for an old-shape row, which names no computer. */
  label: string | null;
  data: CliStatusSnapshot;
};

export type NormalizedCliMachines =
  | {
      ok: true;
      machines: CliMachineSnapshot[];
      /**
       * Which computer the agents run on, when it can be proven. The tenant's
       * bridge address (a URL or tunnel) does not name a pairing, so today this
       * is always null and the readers say so instead of guessing.
       */
      agents_run_on: string | null;
    }
  | { ok: false; reason: "missing" | "stale" | "invalid_inventory" };

/**
 * The apps the vendor refuses on EVERY computer that reports them installed
 * (probe "unsupported"). One computer where the app is ready, or merely not
 * confirmed, means it is not listed: only a finished refusal everywhere is one.
 */
export function unsupportedProviders(machines: readonly CliMachineSnapshot[]): CliProvider[] {
  const out: CliProvider[] = [];
  for (const provider of Object.keys(INSTALL_URLS) as CliProvider[]) {
    const seen = machines.map((m) => m.data[provider]).filter((info) => info && info.installed);
    if (seen.length > 0 && seen.every((info) => info.unsupported === true)) out.push(provider);
  }
  return out;
}

export const AGENTS_RUN_ON_UNKNOWN_NOTE = "Your agents use the computer your bridge points to.";

/**
 * activePairings: pairing id -> label for the workspace's pairings that are NOT
 * revoked. A machine whose pairing is missing from it (revoked, deleted) is
 * dropped. null = the pairings could not be read: the filter is skipped rather
 * than hiding every computer. A computer whose own report is older than the
 * freshness window is dropped; none left = "stale".
 */
export function normalizeCliMachines(
  metadataValue: unknown,
  lastPingAt: string | null | undefined,
  activePairings: ReadonlyMap<string, string | null> | null,
  nowMs: number = Date.now(),
): NormalizedCliMachines {
  if (!lastPingAt) return { ok: false, reason: "missing" };
  const metadata = metadataObject(metadataValue) as (CliInventoryMetadata & { machines?: unknown }) | null;
  const rawMachines = metadata?.machines;

  if (!rawMachines || typeof rawMachines !== "object" || Array.isArray(rawMachines)) {
    // Old shape: the whole row is one unlabeled computer.
    const single = normalizeCliSnapshot(metadataValue, lastPingAt, nowMs);
    return single.ok
      ? { ok: true, machines: [{ id: null, label: null, data: single.data }], agents_run_on: null }
      : single;
  }

  const machines: CliMachineSnapshot[] = [];
  let anyEntry = false;
  let anyFresh = false;
  for (const [id, value] of Object.entries(rawMachines as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (activePairings && !activePairings.has(id)) continue;
    anyEntry = true;
    const entry = value as CliMachineEntry;
    const seen = typeof entry.seen_at === "string" ? freshPingMs(entry.seen_at, nowMs) : "stale";
    if (typeof seen === "string") continue;
    anyFresh = true;
    const data = parseProviders(entry.providers);
    if (!data) continue;
    const stored = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 80) : null;
    machines.push({ id, label: activePairings?.get(id) || stored || "Unnamed computer", data });
  }
  if (machines.length === 0) return { ok: false, reason: anyFresh ? "invalid_inventory" : anyEntry ? "stale" : "missing" };
  machines.sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
  return { ok: true, machines, agents_run_on: null };
}

/**
 * Readers (Settings, the harness strip, the panel) take this shape from
 * /api/bridge/cli-status: `machines`, or a body from before this change with
 * one `data` (shown as a single unlabeled computer).
 */
export function machinesOfBody(body: { machines?: CliMachineSnapshot[]; data?: unknown }): CliMachineSnapshot[] {
  if (Array.isArray(body.machines)) return body.machines;
  if (body.data && typeof body.data === "object") return [{ id: null, label: null, data: body.data as CliStatusSnapshot }];
  return [];
}

export type CliMachinePatch = {
  id: string;
  /** json_set path under metadata, bound as a parameter: a pairing id is never spliced into SQL. */
  path: string;
  entry: { label: string | null; seen_at: string; checked_at: string; providers: unknown };
};

/**
 * What one computer's heartbeat contributes. null when the report carries no
 * providers object or the pairing id is not a plain id (nothing is written).
 */
export function buildCliMachinePatch(
  pairingId: string,
  label: string | null | undefined,
  reported: Record<string, unknown>,
  nowIso: string,
): CliMachinePatch | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(pairingId)) return null;
  const providers = reported.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  const checked = typeof reported.checked_at === "string" && Number.isFinite(Date.parse(reported.checked_at)) ? reported.checked_at : nowIso;
  return {
    id: pairingId,
    path: `$.machines."${pairingId}"`,
    entry: { label: label?.trim() ? label.trim().slice(0, 80) : null, seen_at: nowIso, checked_at: checked, providers },
  };
}
