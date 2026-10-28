/**
 * Shared types + constants for the agent inbox. Single source of truth
 * consumed by:
 *   - lib/agent-inbox-fs.ts (filesystem mirror)
 *   - lib/agent-inbox-db.ts (Supabase canonical)
 *   - components/AgentInboxList.tsx (UI rendering)
 *
 * Adding a new agent slug or priority tier? Edit it ONCE here.
 */

export const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof VALID_PRIORITIES)[number];

export const KNOWN_AGENTS = [
  "bravo",
  "atlas",
  "maven",
  "aura",
  "life-preservation",
  "codex",
  "cc",
  "broadcast",
] as const;
export type KnownAgent = (typeof KNOWN_AGENTS)[number];

/**
 * Agent slugs the inbox composer offers as recipients. Same as
 * KNOWN_AGENTS minus 'cc' (the operator never messages themselves).
 */
export const COMPOSER_RECIPIENTS = KNOWN_AGENTS.filter((a) => a !== "cc");

/**
 * The claim protocol a paired computer advertises in its ping when it runs the
 * agent inbox relay (bravo_cli/inbox_relay.py): app/api/bridge/inbox serves
 * only a computer that advertises it, and Admin > Agent ops can tell a computer
 * that will deliver from one whose bridge predates delivery.
 */
export const AGENT_INBOX_PROTOCOL = "agent_inbox_v1";
