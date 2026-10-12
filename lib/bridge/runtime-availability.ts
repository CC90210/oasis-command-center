import type { WorkspaceApiFallbackReason } from "@/lib/os/runs/types";

type RuntimeRoute = {
  engineKind: "subscription" | "local";
  engineName: string;
};

export type RuntimeAvailability =
  | { ok: true }
  | { ok: false; error: string; fallbackReason?: WorkspaceApiFallbackReason };

function runtimeRoot(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Translate connector runtime truth into the canonical dispatch/fallback vocabulary. */
export function runtimeAvailability(raw: unknown, route: RuntimeRoute): RuntimeAvailability {
  const root = runtimeRoot(raw);
  if (route.engineKind === "subscription") {
    const runtimeState = root[route.engineName];
    if (runtimeState === undefined) return { ok: true };
    if (!runtimeState || typeof runtimeState !== "object" || Array.isArray(runtimeState)) {
      return { ok: false, error: "engine_needs_test" };
    }
    const state = String((runtimeState as Record<string, unknown>).state || "");
    if (["ready", "probe_required"].includes(state)) return { ok: true };
    if (state === "unsupported" || state === "account_unsupported") {
      return { ok: false, error: "cli_account_unsupported", fallbackReason: "cli_account_unsupported" };
    }
    if (["needs_sign_in", "auth_required", "authentication_failed"].includes(state)) {
      return { ok: false, error: "subscription_auth_failure", fallbackReason: "subscription_auth_failure" };
    }
    if (state === "not_installed") return { ok: false, error: "cli_not_found", fallbackReason: "cli_not_found" };
    if (["outdated", "update_required"].includes(state)) {
      return { ok: false, error: "cli_outdated", fallbackReason: "cli_outdated" };
    }
    if (["subscription_limit", "limit_reached", "rate_limited"].includes(state)) {
      return { ok: false, error: "subscription_limit", fallbackReason: "subscription_limit" };
    }
    return { ok: false, error: "engine_needs_test" };
  }
  if (root.local_models === undefined) return { ok: true };
  if (!Array.isArray(root.local_models)) return { ok: false, error: "engine_needs_test" };
  const selected = root.local_models.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const model = entry as Record<string, unknown>;
    return model.ref === route.engineName;
  });
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return { ok: false, error: "model_not_found" };
  return ["ready", "probe_required"].includes(String((selected as Record<string, unknown>).state || ""))
    ? { ok: true }
    : { ok: false, error: "engine_needs_test" };
}
