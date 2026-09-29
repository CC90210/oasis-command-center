/**
 * clients-model — one list of "the business's customers" out of the three
 * places OASIS already records them, until the `customers` table (plan D5)
 * exists. PURE: tests/os-landings.test.ts runs the merge in bare node.
 *
 * Sources, all OASIS-workspace data the viewer was already allowed to read:
 *   won deals   tenant_records leads whose stage proves a sale: won, then the
 *               delivery stages onboarding → in_build → client_review →
 *               launched (lib/website-sales-workflow.ts PAID_OR_DELIVERY).
 *   projects    delivery_projects, linked to the deal by lead_id, else to a
 *               client workspace (client_tenant_id), else by the client's
 *               name/email as typed on the project.
 *   tickets     open support_tickets, attached through their project, their
 *               client workspace, or the requester's email. A ticket from
 *               nobody we know is not a client — it is counted as unlinked.
 *
 * A count the viewer may not read (projects / tickets are founder-only inside
 * OASIS) is null, and renders as an em dash — never 0.
 *
 * A count built from a list that stopped at its read cap is a FLOOR, not a
 * total: it renders as "N+" (shownCount), never as the number alone. Which
 * counts a capped list turns into floors is decided here, in `floors`.
 */

/** Stages that mean "this deal is now a client" (paid, then delivery). */
export const CLIENT_STAGES = ["won", "onboarding", "in_build", "client_review", "launched"] as const;

const STAGE_LABEL: Record<string, string> = {
  won: "Won",
  onboarding: "Onboarding",
  in_build: "In build",
  client_review: "Client review",
  launched: "Launched",
};

const PROJECT_STAGE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  building: "Building",
  review: "In review",
  live: "Live",
  maintenance: "Maintenance",
  paused: "Paused",
};

/** Delivery stages that count as an active project (lib/delivery/rules ACTIVE_PROJECT_STAGES). */
const ACTIVE_PROJECT: ReadonlySet<string> = new Set(["discovery", "building", "review"]);

export type ClientLead = {
  id: string;
  updated_at?: string | null;
  data: Record<string, unknown>;
};

export type ClientProject = {
  id: string;
  title: string;
  lead_id: string | null;
  client_tenant_id: string | null;
  client_tenant_name: string | null;
  client_name: string | null;
  client_email: string | null;
  stage: string;
  last_client_update_at: string | null;
};

export type ClientTicket = {
  id: string;
  project_id: string | null;
  client_tenant_id: string | null;
  client_email: string | null;
  created_at: string;
  last_public_reply_at: string | null;
};

export type ClientRow = {
  key: string;
  name: string;
  /** Contact person, when the name above is a company. */
  contact: string | null;
  status: string;
  /** Null = the viewer may not read tickets, or the read failed. */
  openTickets: number | null;
  /** Null = the viewer may not read projects, or the read failed. */
  activeProjects: number | null;
  lastTouch: string | null;
  href: string | null;
};

/** Which counts are floors ("at least N") because a source list hit its read cap. */
export type ClientFloors = {
  /** The number of clients: a won deal or a project past the cap is a client not listed. */
  clients: boolean;
  /** Per-client and summed open tickets. */
  openTickets: boolean;
  /** Per-client and summed active projects. */
  activeProjects: boolean;
  /** The unlinked-ticket count (only when it is a number). */
  unlinkedTickets: boolean;
};

export type ClientsBuild = { rows: ClientRow[]; unlinkedTickets: number | null; floors: ClientFloors };

/** A count as the page prints it: "12+" when it is a floor. One rule for the whole shell (lib/os/count.ts). */
export { floorCount as shownCount } from "@/lib/os/count";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const norm = (v: string | null | undefined) => (v || "").trim().toLowerCase();

function latest(...isos: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const iso of isos) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (best === null || t > Date.parse(best)) best = iso;
  }
  return best;
}

type Acc = ClientRow & { emails: Set<string>; projectIds: Set<string>; tenantIds: Set<string> };

/**
 * Merge. `projects` / `tickets` null means "not readable by this viewer" and
 * turns that column into an em dash for every row; [] means "readable, none".
 *
 * `capped` says which lists stopped at their read cap (clients-data's
 * `truncated`). What each one makes a floor:
 *   leads     the client count (a won deal past the cap is not listed);
 *   projects  the client count, active projects, AND open tickets — a ticket
 *             attaches through its project, and one past the cap cannot;
 *   tickets   open tickets and the unlinked count.
 * Capped leads or projects make the unlinked count unknown (null), not a
 * floor: a ticket whose client or project was not read lands in "unlinked", so
 * that number can be too high as well as too low.
 */
export function buildClientRows(input: {
  leads: readonly ClientLead[];
  projects: readonly ClientProject[] | null;
  tickets: readonly ClientTicket[] | null;
  capped?: { leads?: boolean; projects?: boolean; tickets?: boolean };
}): ClientsBuild {
  const rows = new Map<string, Acc>();
  const byLead = new Map<string, Acc>();
  const byTenant = new Map<string, Acc>();
  const byEmail = new Map<string, Acc>();
  const byName = new Map<string, Acc>();
  const byProject = new Map<string, Acc>();
  const projectsKnown = input.projects !== null;
  const ticketsKnown = input.tickets !== null;

  const add = (acc: Acc) => {
    rows.set(acc.key, acc);
    return acc;
  };
  const blank = (key: string, name: string, contact: string | null, status: string, href: string | null): Acc => ({
    key,
    name,
    contact,
    status,
    openTickets: ticketsKnown ? 0 : null,
    activeProjects: projectsKnown ? 0 : null,
    lastTouch: null,
    href,
    emails: new Set(),
    projectIds: new Set(),
    tenantIds: new Set(),
  });

  for (const lead of input.leads) {
    const stage = str(lead.data.stage) || "";
    if (!(CLIENT_STAGES as readonly string[]).includes(stage)) continue;
    const company = str(lead.data.company) || str(lead.data.business_name);
    const person = str(lead.data.name) || str(lead.data.contact_name);
    const email = str(lead.data.email);
    const name = company || person || email || "Unnamed client";
    const acc = add(blank(`lead:${lead.id}`, name, company && person ? person : null, STAGE_LABEL[stage] ?? stage, `/pipeline/${lead.id}`));
    acc.lastTouch = latest(str(lead.data.last_contacted_at));
    byLead.set(lead.id, acc);
    if (email) {
      acc.emails.add(norm(email));
      byEmail.set(norm(email), acc);
    }
    byName.set(norm(name), acc);
  }

  for (const p of input.projects ?? []) {
    const typedName = p.client_tenant_name || p.client_name;
    let acc: Acc | undefined =
      (p.lead_id ? byLead.get(p.lead_id) : undefined) ??
      (p.client_tenant_id ? byTenant.get(p.client_tenant_id) : undefined) ??
      (p.client_email ? byEmail.get(norm(p.client_email)) : undefined) ??
      (typedName ? byName.get(norm(typedName)) : undefined);
    if (!acc) {
      // A project for someone the pipeline never recorded as won (an older
      // client, a client workspace set up by hand) is still a client.
      const name = p.client_tenant_name || p.client_name || p.client_email || p.title || "Unnamed client";
      const key = p.client_tenant_id ? `tenant:${p.client_tenant_id}` : `project:${p.id}`;
      acc = rows.get(key) ?? add(blank(key, name, p.client_tenant_name && p.client_name ? p.client_name : null, PROJECT_STAGE_LABEL[p.stage] ?? p.stage, `/projects/${p.id}`));
      byName.set(norm(name), acc);
    }
    if (p.client_tenant_id) {
      acc.tenantIds.add(p.client_tenant_id);
      byTenant.set(p.client_tenant_id, acc);
    }
    if (p.client_email) {
      acc.emails.add(norm(p.client_email));
      if (!byEmail.has(norm(p.client_email))) byEmail.set(norm(p.client_email), acc);
    }
    acc.projectIds.add(p.id);
    byProject.set(p.id, acc);
    if (ACTIVE_PROJECT.has(p.stage)) acc.activeProjects = (acc.activeProjects ?? 0) + 1;
    acc.lastTouch = latest(acc.lastTouch, p.last_client_update_at);
  }

  let unlinked = 0;
  for (const t of input.tickets ?? []) {
    const acc: Acc | undefined =
      (t.project_id ? byProject.get(t.project_id) : undefined) ??
      (t.client_tenant_id ? byTenant.get(t.client_tenant_id) : undefined) ??
      (t.client_email ? byEmail.get(norm(t.client_email)) : undefined);
    if (!acc) {
      unlinked += 1;
      continue;
    }
    acc.openTickets = (acc.openTickets ?? 0) + 1;
    acc.lastTouch = latest(acc.lastTouch, t.last_public_reply_at, t.created_at);
  }

  const out: ClientRow[] = [...rows.values()].map(({ emails: _e, projectIds: _p, tenantIds: _t, ...row }) => row);
  out.sort((a, b) => {
    const ta = a.lastTouch ? Date.parse(a.lastTouch) : -Infinity;
    const tb = b.lastTouch ? Date.parse(b.lastTouch) : -Infinity;
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name);
  });
  const capped = input.capped ?? {};
  const leadsCapped = capped.leads === true;
  const projectsCapped = projectsKnown && capped.projects === true;
  const ticketsCapped = ticketsKnown && capped.tickets === true;
  const unlinkedKnown = ticketsKnown && !leadsCapped && !projectsCapped;
  return {
    rows: out,
    unlinkedTickets: unlinkedKnown ? unlinked : null,
    floors: {
      clients: leadsCapped || projectsCapped,
      openTickets: ticketsKnown && (ticketsCapped || projectsCapped),
      activeProjects: projectsCapped,
      unlinkedTickets: unlinkedKnown && ticketsCapped,
    },
  };
}
