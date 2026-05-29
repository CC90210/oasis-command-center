/**
 * useAgentDisplayNames — client-side hook that fetches the operator's
 * per-user agent display-name overrides once at mount and surfaces a
 * `labelFor(agentKey)` helper.
 *
 * Per-user renames live in agent_model_config.display_name_override
 * (migration 075) and are only consulted from user-scope rows. The
 * /api/agent-config?scope=user GET returns them alongside the per-user
 * provider/model overrides. This hook pulls that response, builds a
 * Record<agentKey, displayName>, and lets any client component call
 * `labelFor(key)` to render the operator's nickname for an agent OR
 * fall back to the canonical label from lib/agents.ts when the
 * operator hasn't set one.
 *
 * Use it for the chat header, sidebar nav label, message download
 * heading, and any other surface that renders an agent's name back
 * to the operator. NEVER use it for backend-facing logs — those
 * always stay on the canonical agent_key per the planning decision.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { getAgentInfo } from "./agents";

type UserAgentConfig = {
  agent_key: string;
  display_name_override: string | null;
};

export function useAgentDisplayNames() {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-config?scope=user")
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          configs?: UserAgentConfig[];
        };
        if (!body.ok || !body.configs || cancelled) return;
        const next: Record<string, string> = {};
        for (const cfg of body.configs) {
          const name = (cfg.display_name_override || "").trim();
          if (name) next[cfg.agent_key] = name;
        }
        setOverrides(next);
      })
      .catch(() => {
        // Soft-fail — fallthrough to canonical names everywhere. A
        // failed fetch is not worth alerting on; canonical labels are
        // still a working UX.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const labelFor = useCallback(
    (agentKey: string): string => {
      const override = overrides[agentKey];
      if (override) return override;
      const canonical = getAgentInfo(agentKey).label;
      return canonical || agentKey.toUpperCase();
    },
    [overrides],
  );

  return { labelFor, loaded };
}
