/**
 * lib/os/chat-href.ts - the one way a page hands a prompt to a department.
 *
 *   askDepartment("finance", "What's owing on tax?")
 *     -> /team/finance?ask=What's%20owing%20on%20tax%3F
 *
 * WHY. Five surfaces (the business docs, the prompts library, the drills, the
 * client-deploy runbook and the quick-actions grid) built
 * `/agents?agent=<slug>&prompt=<text>`. /agents became the AI Team roster: it
 * reads no search params, so the prompt was dropped, and it is a system
 * surface, so every OASIS member who is not a founder got "Page not found".
 * Where the hidden operator chat was still mounted it read `?prompt` from any
 * path, put it in an invisible composer and stripped the URL (audit
 * 2026-09-30, business-docs-link-to-ai-team). A department channel is where a
 * person talks to the team now, so the prompt goes there.
 *
 * `?ask=` is read ONCE by the department's composer (ComposerContext), which
 * prefills the message box and then replaces the URL without it. It is never
 * sent on the viewer's behalf: sending stays the person's own keystroke.
 *
 * Zero server imports, so client components (the prompts filter, the quick
 * actions grid) can use it.
 */

import { OS_DEPARTMENTS } from "@/lib/os/departments";

/** The query parameter a department page prefills its composer from. */
export const ASK_PARAM = "ask";

/**
 * Longest prompt carried in a URL. Some prompts-library entries are long
 * system messages; past this the link would outgrow what proxies accept once
 * percent-encoded, so the text is cut here and the person sees what arrived.
 */
export const ASK_MAX_CHARS = 4000;

export type AskDepartmentSlug = "chief-of-staff" | "sales" | "marketing" | "client-success" | "finance" | "operations";

const SLUGS = new Set<string>(OS_DEPARTMENTS.map((d) => d.slug));

/**
 * True when `prompt` fits in an ask link. A longer one (two prompts-library
 * system messages run to 5,800 and 13,200 characters) is offered as Copy only:
 * cutting it to fit would hand the department a prompt that silently lost its
 * end.
 */
export function fitsAskLink(prompt: string): boolean {
  return (prompt || "").trim().length <= ASK_MAX_CHARS;
}

/**
 * `/team/<dept>?ask=<prompt>`; `/team/<dept>` alone when the prompt is empty.
 * Throws for a prompt that does not fit (check fitsAskLink first): a link that
 * carried half a prompt would look like it carried all of it.
 */
export function askDepartment(dept: AskDepartmentSlug, prompt: string): string {
  if (!SLUGS.has(dept)) throw new Error(`askDepartment: unknown department "${dept}"`);
  const base = `/team/${dept}`;
  const body = (prompt || "").trim();
  if (body.length > ASK_MAX_CHARS) {
    throw new RangeError(`askDepartment: prompt is ${body.length} characters; a link carries at most ${ASK_MAX_CHARS}`);
  }
  return body ? `${base}?${ASK_PARAM}=${encodeURIComponent(body)}` : base;
}

/**
 * The ask link for `prompt`, or null when the viewer may not open `dept` or
 * the prompt does not fit in a link. `open` is the set of departments the
 * server computed for this viewer with the rail's own gate
 * (lib/playbook/ask-access.ts openAskDepartments): every OASIS member reads the
 * Playbook, but a sales rep cannot open Marketing or Finance, and a link to a
 * department they cannot open is a "Page not found".
 */
export function askIfOpen(dept: AskDepartmentSlug, prompt: string, open: readonly string[]): string | null {
  if (!open.includes(dept) || !fitsAskLink(prompt)) return null;
  return askDepartment(dept, prompt);
}

/** The department slug a `/team/<slug>` href opens, or null for any other href. */
export function teamSlugOf(href: string): string | null {
  const m = /^\/team\/([a-z-]+)(?:[?#/]|$)/.exec(href);
  return m ? m[1] : null;
}

/** The department's label ("Chief of Staff"), for link text. */
export function departmentLabel(dept: AskDepartmentSlug): string {
  const row = OS_DEPARTMENTS.find((d) => d.slug === dept);
  if (!row) throw new Error(`departmentLabel: unknown department "${dept}"`);
  return row.label;
}

/**
 * Which department answers for a house agent's prompt. The departments bind
 * the same agents (components/os/department/config.ts): Chief of Staff and
 * Operations run on bravo, Marketing on maven, Finance on atlas. The client
 * packs map by what the agent does (Solara and Helios sold, Hermes ran
 * operations). An agent this table does not name goes to the Chief of Staff,
 * the department that takes "anything".
 */
const AGENT_DEPARTMENT: Readonly<Record<string, AskDepartmentSlug>> = {
  bravo: "chief-of-staff",
  aura: "chief-of-staff",
  lex: "chief-of-staff",
  atlas: "finance",
  maven: "marketing",
  hermes: "operations",
  solara: "sales",
  helios: "sales",
};

export function departmentForAgent(agent: string | null | undefined): AskDepartmentSlug {
  return AGENT_DEPARTMENT[(agent || "").trim().toLowerCase()] ?? "chief-of-staff";
}

/** A business document's owning pillar -> the department that drafts it. */
export type DocOwnerPillar = "ceo" | "cfo" | "cmo" | "ops" | "legal";
const PILLAR_DEPARTMENT: Readonly<Record<DocOwnerPillar, AskDepartmentSlug>> = {
  ceo: "chief-of-staff",
  legal: "chief-of-staff",
  cfo: "finance",
  cmo: "marketing",
  ops: "operations",
};

export function departmentForDocOwner(owner: DocOwnerPillar): AskDepartmentSlug {
  return PILLAR_DEPARTMENT[owner];
}

/**
 * Read `?ask=` from a location's query string, for the composer. Returns the
 * prefill (trimmed, capped; null when absent or empty) and the query string
 * with `ask` removed, which the composer puts back in the address bar so a
 * reload or a shared link does not prefill again.
 *
 * `present` is true whenever the parameter was in the URL, even empty: the
 * composer still cleans the URL then.
 */
export function consumeAskParam(search: string): { present: boolean; text: string | null; rest: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has(ASK_PARAM)) return { present: false, text: null, rest: params.toString() };
  const text = (params.get(ASK_PARAM) || "").trim().slice(0, ASK_MAX_CHARS);
  params.delete(ASK_PARAM);
  return { present: true, text: text || null, rest: params.toString() };
}

/** The part of `window` the composer's `?ask=` read touches, and nothing else. */
export type AskWindow = {
  location: { search: string; pathname: string; hash: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void };
};

/**
 * The department composer's one read of `?ask=` (ComposerContext calls this
 * once, on mount, with `window`): hand the text to `prefill` when the channel
 * can answer, then replace the URL without the parameter. It returns the text
 * it prefilled (null when none).
 *
 * It only PREFILLS. It touches the location and history it is given and
 * nothing else: no form, no fetch, no send. Sending stays the person's own
 * keystroke (tests/playbook-docs.test.ts runs it against a window whose every
 * other door records the attempt).
 */
export function applyAskParam(win: AskWindow, channelReady: boolean, prefill: (text: string) => void): string | null {
  const { present, text, rest } = consumeAskParam(win.location.search);
  if (!present) return null;
  const filled = text && channelReady ? text : null;
  if (filled) prefill(filled);
  const clean = `${win.location.pathname}${rest ? `?${rest}` : ""}${win.location.hash}`;
  win.history.replaceState(win.history.state, "", clean);
  return filled;
}
