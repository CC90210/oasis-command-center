"use client";

/**
 * The two views of Admin > Agent ops (2026-10-28): what the agents were told, and what they did.
 * The tab list is a constant here, so a page passes only which tab it is.
 */
import { OsTabBar, type OsTab } from "@/components/os/OsTabBar";

const AGENT_OPS_TABS: readonly OsTab[] = [
  { key: "handoffs", label: "Handoffs & directives", href: "/agent-ops" },
  { key: "trace", label: "Execution trace", href: "/agent-ops/trace" },
];

export function AgentOpsTabs({ active }: { active: "handoffs" | "trace" }) {
  return <OsTabBar label="Agent ops" tabs={AGENT_OPS_TABS} active={active} />;
}
