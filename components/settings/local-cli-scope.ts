/**
 * What Settings > AI brain's paired-computer card shows and chooses, in the
 * words it shows.
 *
 * 2026-10-09 (CC: "the Coding Harness and then all of the department agents ...
 * should have the same background workings"). What powers your agents is ONE
 * choice, "What powers your agents" (components/settings/AgentEnginePanel.tsx,
 * lib/ai/agent-engine.ts): an AI account, an AI app on the paired computer, or
 * a local model there. This card is that computer's status (which apps it
 * reported and whether each is signed in) and ONE extra choice that only the
 * coding harness needs: the coding harness edits files, so it always runs on
 * an app on the computer, even when your agents answer on an AI account. It
 * follows your agents' app when they run on one; a pick here changes the
 * coding harness alone, in this browser, and says so.
 *
 * PURE: no imports (components/settings/LocalCliProvidersCard.tsx shows them).
 */

export const LOCAL_CLI_SCOPE =
  "The AI apps on your paired computer, as it last reported them. What powers your agents is chosen above, in What powers your agents. Setup commands run directly only when this dashboard is opened on that computer; elsewhere the card shows the exact command to run there.";

export const LOCAL_CLI_PICKER_SCOPE =
  "The coding harness edits files, so it always runs on an app on the paired computer. It uses your agents' app when they run on one; pick another here to change the coding harness alone (in this browser). It never changes what your agents use.";
