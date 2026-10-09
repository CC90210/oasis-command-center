/**
 * What Settings > AI brain's paired-computer card shows, in the words it shows.
 *
 * 2026-10-09 (CC: "the coding harness and the department agents should share
 * the same connection, which is the CLI bridge ... I don't want this to
 * confuse these; they should be on the same functionality"). What powers your
 * agents AND the coding harness is ONE setting, "What powers your agents"
 * (components/settings/AgentEnginePanel.tsx, lib/ai/agent-engine.ts). This
 * card chooses nothing: it is the paired computer's report of its AI apps,
 * with each app's Connect / Reconnect.
 *
 * PURE: no imports (components/settings/LocalCliProvidersCard.tsx shows it).
 */

export const LOCAL_CLI_SCOPE =
  "The AI apps on your paired computer, as it last reported them, with Connect to sign each one in there. Which app your agents and the coding harness use is the one setting above, in What powers your agents.";
