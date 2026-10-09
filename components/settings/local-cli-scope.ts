/**
 * What Settings > AI brain's local CLI card chooses, in the words it shows (CC,
 * 2026-10-09: "it says I have Codex CLI selected, but then ... it says I'm
 * using Gemini"). The CLI picked there answers ONLY the operator's Coding
 * harness (/agent, components/ChatWidget.tsx) when that chat runs on the
 * paired computer: its "On this computer" mode, or Auto while the computer is
 * online, sends `cli_provider` to the bridge. No department ever uses it:
 * department chats answer on the workspace AI account set in AI setup
 * (lib/ai/department-brain.ts), so the card says that, and never reads as a
 * second place choosing the department brain.
 *
 * PURE: no imports (components/settings/LocalCliProvidersCard.tsx shows them).
 */

export const LOCAL_CLI_SCOPE =
  "The AI command-line tools on your paired computer. They answer only the Coding harness (Admin > Coding harness) when it runs on that computer. Your departments do not use them: what powers your departments is the AI account and model in AI setup above. Setup commands run directly only when this dashboard is opened on that computer; elsewhere the card shows the exact command to run there.";

export const LOCAL_CLI_PICKER_SCOPE =
  "Which tool answers the Coding harness when it runs on the paired computer (it also sets the Coding harness's own picker). It never changes what your departments use.";
