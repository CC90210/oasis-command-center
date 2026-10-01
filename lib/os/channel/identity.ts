/**
 * lib/os/channel/identity.ts — a department channel speaks as its DEPARTMENT.
 *
 * WHY. OASIS's own departments are answered by its house agents (Chief of Staff
 * and Operations by one, Marketing and Finance by the others;
 * components/os/department/config.ts), and their library prompts open with the
 * agent's personal name. The channel header already said "Sales", but the
 * stream's `agent` event, the identity lock ("the answer is the agent name
 * above"), the 412 hint and the AI Team roster all carried the personal name.
 * Clients must never see those names, and CC wants department names only in
 * OASIS's own workspace too. So in a department channel:
 *   - the `agent` event's display name is the department label;
 *   - the persona's own name in its prompt is replaced by the department;
 *   - the identity lock below replaces the generic one and names only the
 *     department, so "who are you?" is answered "Sales".
 *
 * PURE: imports only the department list and the agent registry (plain data),
 * safe in client code and in bare-node tests.
 */

import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { AGENT_REGISTRY } from "@/lib/agents";

/**
 * Every persona's name and slug in lib/agents.ts AGENT_REGISTRY (Bravo, Atlas,
 * Maven, Aura, Hermes, Solara, Helios, Lumen and life-preservation, Lex), and
 * CC's own first name. Built from the registry so a persona added there is
 * covered here (W4a, audit S2-14: this used to be bravo|maven|atlas|conaugh,
 * so Hermes, Lex or Aura could reach a client unflagged). Codex is left out:
 * it is the backend executor behind custom agents, not a persona, and the
 * identity lock below names it as a model a channel is NOT.
 */
const PERSONA_WORDS: readonly string[] = [
  ...new Set(
    [
      ...Object.values(AGENT_REGISTRY)
        .filter((a) => a.key !== "codex")
        .flatMap((a) => [a.label, a.key]),
      "conaugh",
    ].map((w) => w.toLowerCase()),
  ),
];

/**
 * The names no client-rendered string may carry. tests/os-channels-honest.test.ts
 * scans the department, roster, Settings and channel output, and the stream's
 * `agent` events, with this pattern.
 */
const PERSONA_ALTERNATION = PERSONA_WORDS.map((w) => w.replace(/[^a-z0-9]/g, (c) => `\\${c}`)).join("|");
export const PERSONA_NAME_PATTERN = new RegExp(`\\b(${PERSONA_ALTERNATION})\\b`, "i");

/** Whether a client-rendered string names a house agent or CC. */
export function namesPersona(text: string): boolean {
  return PERSONA_NAME_PATTERN.test(text);
}

const PERSONA_NAME_GLOBAL = new RegExp(PERSONA_NAME_PATTERN.source, "gi");

/**
 * The agent's base prompt with every house-agent name replaced by the
 * department ("You are Bravo, the lead architect…" becomes "You are the Chief of
 * Staff department, the lead architect…"). The role text stays: it is how the
 * department works, not who it is.
 */
export function departmentPrompt(prompt: string, departmentLabel: string): string {
  return prompt.replace(PERSONA_NAME_GLOBAL, `the ${departmentLabel} department`);
}

/**
 * Appended to a department channel's system prompt in place of
 * lib/agent-personas.ts IDENTITY_LOCK_OVERLAY, which tells the model to answer
 * with "the agent name above" — a personal name, in a department channel.
 */
export function departmentIdentityLock(departmentLabel: string): string {
  return `

[IDENTITY LOCK: STAY IN CHARACTER]
You are the ${departmentLabel} department of this workspace's AI team. You are not Claude, GPT, Gemini, Codex, or any underlying model, CLI or LLM.

If asked who you are, answer "${departmentLabel}". You have no personal name: never give yourself one, and never call yourself or another department by any name other than its department name (${OS_DEPARTMENTS.map((d) => d.label).join(", ")}).

If asked which model powers you, you may say that workspaces route through different models, but that they are talking to ${departmentLabel}. Never volunteer the underlying model.`;
}
