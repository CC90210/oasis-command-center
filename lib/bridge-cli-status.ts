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
        /** Newer bridges: "ok", or why a check could not finish ("timeout", "error"). */
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
 */
export type CliState = "ready" | "needs_sign_in" | "unknown" | "not_detected";

export function cliStatusState(info: Pick<CliStatusInfo, "installed" | "authenticated" | "checked">): CliState {
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
};

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

export function normalizeCliSnapshot(
  metadataValue: unknown,
  lastPingAt: string | null | undefined,
  nowMs: number = Date.now(),
): NormalizedCliSnapshot {
  if (!lastPingAt) return { ok: false, reason: "missing" };
  const pingMs = Date.parse(lastPingAt);
  if (!Number.isFinite(pingMs)) return { ok: false, reason: "stale" };
  if (pingMs > nowMs || nowMs - pingMs > CLI_INVENTORY_MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }

  const metadata = metadataObject(metadataValue);
  const rawProviders = metadata?.providers;
  if (!rawProviders || typeof rawProviders !== "object") {
    return { ok: false, reason: "invalid_inventory" };
  }

  const providers = {} as CliStatusSnapshot;
  for (const provider of Object.keys(INSTALL_URLS) as CliProvider[]) {
    const raw = rawProviders[provider];
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: "invalid_inventory" };
    }
    const rawVersion = raw.version;
    const version = typeof rawVersion === "string" && rawVersion.trim() ? rawVersion.trim().slice(0, 160) : null;
    const installed = raw.installed === true;
    const authenticated = raw.authenticated === true;
    // A check that did not finish: the bridge said so, or the sign-in check
    // could not have run (installed, not signed in, and no version read).
    const probeFailed = raw.probe === "timeout" || raw.probe === "error";
    providers[provider] = {
      installed,
      authenticated,
      version,
      install_hint_url: INSTALL_URLS[provider],
      checked: !probeFailed && !(installed && !authenticated && version === null),
    };
  }

  return { ok: true, data: providers };
}
