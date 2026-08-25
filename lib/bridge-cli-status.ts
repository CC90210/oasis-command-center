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
      }
    >
  >;
};

export type CliStatusInfo = {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  install_hint_url: string;
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
  if (nowMs - pingMs > CLI_INVENTORY_MAX_AGE_MS) {
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
    providers[provider] = {
      installed: raw.installed === true,
      authenticated: raw.authenticated === true,
      version:
        typeof rawVersion === "string" && rawVersion.trim()
          ? rawVersion.trim().slice(0, 160)
          : null,
      install_hint_url: INSTALL_URLS[provider],
    };
  }

  return { ok: true, data: providers };
}
