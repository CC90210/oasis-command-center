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
 * PURE: imports only the department list, safe in client code and in
 * bare-node tests.
 */

import { OS_DEPARTMENTS } from "@/lib/os/departments";

/**
 * The names no client-rendered string may carry. Three house agents and CC's
 * own first name (the operator persona). tests/os-channels-honest.test.ts scans
 * the department, roster and channel output, and the stream's `agent` events,
 * with this pattern.
 */
export const PERSONA_NAME_PATTERN = /\b(bravo|maven|atlas|conaugh)\b/i;

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
