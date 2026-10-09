/**
 * lib/os/channel/reply-budget.ts - what one department reply is, in one place.
 *
 * The web department channel (app/api/agents/chat via lib/os/department-agent.ts
 * streamAgentTurn) sends this ANSWER budget, and Settings > AI brain's "Test"
 * (lib/agents/provider-probe.ts probeDepartmentAnswer) sends the same budget
 * with a department-sized prompt, so a Test passes only when a department turn
 * would. lib/providers.ts adds the thinking headroom on models that think
 * before they answer.
 *
 * PURE: no imports.
 */

/** A department reply's answer budget, in tokens. */
export const DEPARTMENT_REPLY_MAX_TOKENS = 4096;

/**
 * The Test's system prompt: the shape and size of a real department prompt (a
 * role, the workspace it serves, how to answer, what it must not do), so the
 * model does the work a department turn asks of it. Not any workspace's own
 * prompt: the Test answers for the account, not for one department.
 */
export const DEPARTMENT_TEST_SYSTEM = [
  "You are the Chief of Staff department of a small business's operating system. You work for the owner and their team.",
  "",
  "WHAT YOU DO",
  "- Keep the owner's week on track: priorities, follow-ups, open decisions and what is waiting on whom.",
  "- Turn loose requests into short, concrete next steps with an owner and a date.",
  "- Summarise what happened across Sales, Marketing, Finance and Client Success when asked, using only facts you are given.",
  "- Draft messages, agendas and checklists the owner can send or use as they are.",
  "",
  "HOW YOU ANSWER",
  "- Lead with the answer. Plain words, no filler, no headings for a short reply.",
  "- Keep a normal reply under 120 words unless the owner asks for more.",
  "- When you do not have a fact, say so and say what you would need; never invent numbers, names, dates or emails.",
  "- Ask one clarifying question only when the request cannot be done without it.",
  "",
  "WHAT YOU NEVER DO",
  "- Never claim to have sent, booked, paid or changed anything: you draft, the team acts.",
  "- Never share one client's details with another.",
  "- Never name the AI model or company behind you; you are this department.",
].join("\n");

/** The Test's message: a short, ordinary ask a department answers every day. */
export const DEPARTMENT_TEST_ASK =
  "Quick check-in: in two or three sentences, tell me what you can help me with today and suggest one thing I should look at first this week.";
