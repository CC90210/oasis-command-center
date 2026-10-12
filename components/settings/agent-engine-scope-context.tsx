"use client";

import * as React from "react";
import type { ReactNode } from "react";
import type { EngineScope } from "@/components/settings/agent-engine-client";

// Next keeps this client module behind its RSC boundary. A few route-level
// tests deliberately import the whole tree through React's `react-server`
// export, which has no createContext. In that environment the card behaves as
// its documented legacy standalone form; the browser always takes the real
// context branch.
const AgentEngineScopeContext =
  typeof React.createContext === "function"
    ? React.createContext<EngineScope | undefined>(undefined)
    : null;

const useScopeValue: () => EngineScope | undefined = AgentEngineScopeContext
  ? () => React.useContext(AgentEngineScopeContext)
  : () => undefined;

export function AgentEngineScopeProvider({ scope, children }: { scope: EngineScope; children: ReactNode }) {
  if (!AgentEngineScopeContext) return <>{children}</>;
  return <AgentEngineScopeContext.Provider value={scope}>{children}</AgentEngineScopeContext.Provider>;
}

/** Undefined only for legacy standalone renders outside the canonical panel. */
export function useAgentEngineScope(): EngineScope | undefined {
  return useScopeValue();
}
