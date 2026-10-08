/**
 * components/os/aiteam/templates.ts — the starting points for "New teammate"
 * (plan D4 / pillar 11): Setter, Support rep, Bookkeeper, Media buyer, Content
 * producer, Project manager.
 *
 * PURE DATA, written for any business: no OASIS names, no agent personas, no
 * CC. tests/os-departments.test.ts holds that line, because these render on
 * every workspace's AI Team page.
 *
 * `brief` is the paragraph for the builder's "Describe what this agent should
 * do" field. The template link carries `?template=<key>`, and
 * components/marketplace/CustomAgentBuilder.tsx opens prefilled from it
 * (templateDraft: name, category, one-line summary and brief; W4a, audit
 * S2-06). `category` is the builder's own category key (lib/agents/library.ts
 * AgentCategory).
 */

import type { AgentCategory } from "@/lib/agents/library";

export type TeammateTemplate = {
  key: string;
  name: string;
  department: string;
  category: AgentCategory;
  /** One line on the card. */
  summary: string;
  /** Paste into the builder's description field. */
  brief: string;
};

export const TEAMMATE_TEMPLATES: readonly TeammateTemplate[] = [
  {
    key: "setter",
    name: "Setter",
    department: "Sales",
    category: "sales",
    summary: "Replies to new leads fast and books the call.",
    brief:
      "Appointment setter for our business. Replies to every new lead within minutes, asks two or three qualifying questions, and offers real times from our calendar to book a call. Drafts every message for approval before it is sent. Hands a qualified lead to a person with a one-line summary.",
  },
  {
    key: "support-rep",
    name: "Support rep",
    department: "Client Success",
    category: "support",
    summary: "Answers client questions from your docs and opens tickets.",
    brief:
      "First-line support for our clients. Answers questions only from our own documents and past replies, opens a ticket for anything new or urgent, and drafts replies for a person to approve. Never invents a policy, a price or a date.",
  },
  {
    key: "bookkeeper",
    name: "Bookkeeper",
    department: "Finance",
    category: "finance",
    summary: "Categorizes transactions and chases overdue invoices.",
    brief:
      "Bookkeeping assistant. Categorizes new transactions, flags anything unusual or duplicated, lists overdue invoices each week and drafts polite reminders for approval. Reads the numbers; never moves money.",
  },
  {
    key: "media-buyer",
    name: "Media buyer",
    department: "Marketing",
    category: "cmo",
    summary: "Watches ad performance and proposes budget moves.",
    brief:
      "Paid-ads analyst. Reviews campaign, ad set and ad performance daily, names the winners and the fatigued ads, and proposes budget changes with the expected effect. Every change is a proposal for a person to approve; it never changes spend on its own.",
  },
  {
    key: "content-producer",
    name: "Content producer",
    department: "Marketing",
    category: "content",
    summary: "Turns your ideas into posts, emails and scripts.",
    brief:
      "Content producer. Turns our ideas, client wins and notes into social posts, short video scripts and emails in our voice. Offers three hooks per piece, keeps each draft short, and waits for approval before anything is scheduled.",
  },
  {
    key: "project-manager",
    name: "Project manager",
    department: "Client Success",
    category: "operations",
    summary: "Keeps client projects on schedule and clients updated.",
    brief:
      "Project manager for client work. Tracks every project's stage, due dates and blockers, writes a short weekly update for each client, and flags anything slipping before it is late. Drafts client updates for approval.",
  },
];

/**
 * What the builder starts from for `?template=<key>`, or null for no key or an
 * unknown one (the builder then starts empty, as it always did).
 */
export function templateDraft(
  key: string | null | undefined,
): Pick<TeammateTemplate, "name" | "category" | "summary" | "brief"> | null {
  const k = (key || "").trim().toLowerCase();
  const t = k ? TEAMMATE_TEMPLATES.find((x) => x.key === k) : undefined;
  return t ? { name: t.name, category: t.category, summary: t.summary, brief: t.brief } : null;
}
