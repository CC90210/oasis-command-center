/**
 * SunBiz agent roster (Jordan / Alex / Matt) — read at REQUEST time
 * from agents.config.json at the repo root.
 *
 * This is the source of truth for the shop-out derived-CC list (Adon's
 * 2026-06-10 spec, section 2). When the operator fires a shop-out, the
 * application row's rep fields are intersected against these agents to
 * produce the auto-checked CC list. Anyone whose email isn't in this
 * file is excluded — processors, admins, ops, etc. don't get CC'd on
 * lender outreach.
 *
 * Request-time read (NOT module-scope cache) so editing the config file
 * during a deployment takes effect on the next request without a
 * rebuild. Reads are cheap (sub-millisecond JSON parse on hot filesystem
 * cache); the safety win is worth it.
 *
 * Signer rule (Adon spec 2.4):
 *   - Exactly one agent on CC after operator finalization → THAT agent
 *     signs (name + phone from this file)
 *   - Zero or multiple → signer is "SunBiz Submissions", phone omitted
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveSignerName } from "@/lib/lenders/derive-signer-label";

export type AgentEntry = {
  /** Stable lowercase identifier — used as agents[].key in the config. */
  key: string;
  /** Display name used in email signatures. */
  name: string;
  /** Email used for CC routing + intersection against deal rep fields. */
  email: string;
  /**
   * Phone used in email signature. Empty string means omit the phone
   * line entirely (per Adon spec section 6 rule).
   */
  phone: string;
};

/**
 * Returns the current agent roster. Reads agents.config.json fresh on
 * every call — a quirk Adon's spec relies on for runtime config flips.
 * If the file is missing or malformed the function throws; the caller
 * should treat that as a deployment defect (the build never ships
 * without this file).
 */
export function getAgents(): AgentEntry[] {
  // process.cwd() is the project root in Next.js (server runtime + dev).
  // agents.config.json sits at the repo root per Adon's spec.
  const path = join(process.cwd(), "agents.config.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { agents?: unknown };
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new Error("agents.config.json malformed: expected { agents: [...] }");
  }
  return parsed.agents.map((entry) => {
    const e = entry as Partial<AgentEntry>;
    if (
      typeof e.key !== "string" ||
      typeof e.name !== "string" ||
      typeof e.email !== "string" ||
      typeof e.phone !== "string"
    ) {
      throw new Error(
        `agents.config.json malformed: entry missing required string fields (got ${JSON.stringify(entry)})`,
      );
    }
    return { key: e.key, name: e.name, email: e.email, phone: e.phone };
  });
}

/**
 * Case-insensitive email lookup against the current roster. Returns
 * null if no match — caller decides whether that's an error or a
 * valid "not on the team" signal (it's the latter for processors
 * who shouldn't be CC'd on lender outreach).
 */
export function findAgentByEmail(email: string | null | undefined): AgentEntry | null {
  if (!email) return null;
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const roster = getAgents();
  for (const agent of roster) {
    if (agent.email.trim().toLowerCase() === target) return agent;
  }
  return null;
}

/**
 * Derive the full signer (name + email + phone) from the final CC list
 * (Adon spec 2.4). Server-side wrapper around the pure deriveSignerName
 * rule — adds the email + phone lookup that needs the fs-touching
 * roster + env var read.
 */
export function deriveSigner(
  ccEmails: string[],
): { name: string; email: string; phone: string } {
  const roster = getAgents();
  const name = deriveSignerName(ccEmails, roster);
  // Sole-agent path: deriveSignerName already returned that agent's name —
  // find the rest of their contact info via the same roster.
  if (ccEmails.length === 1 && name !== "SunBiz Submissions") {
    const target = ccEmails[0].trim().toLowerCase();
    for (const agent of roster) {
      if (agent.email.trim().toLowerCase() === target) {
        return { name: agent.name, email: agent.email, phone: agent.phone };
      }
    }
  }
  // Shared identity (zero or multiple agents): submissions inbox + no phone.
  return {
    name: "SunBiz Submissions",
    email: process.env.SUNBIZ_SUBMISSIONS_EMAIL || "submissions@sunbizfunding.com",
    phone: "",
  };
}
