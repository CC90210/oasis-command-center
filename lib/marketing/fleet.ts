/**
 * The agent fleet, as presented publicly.
 *
 * EVERY CLAIM HERE IS LOAD-BEARING. This is the page a prospect reads
 * before they decide whether OASIS is real, so it is written against what
 * the fleet actually does today, not what it is scheduled to do.
 *
 * Rules that produced this list, and that any edit has to keep:
 *   - `state: "live"` means the agent runs today. Orion and Iris are
 *     roadmap lines in memory/DECISIONS.md with no repo and no code —
 *     they are deliberately absent. Suga was retired in 2026-07.
 *   - Atlas and Maven are live but have zero registered cron jobs, so
 *     neither is described as always-on or autonomous. Their readouts say
 *     "on request", which is true.
 *   - Aura is voice / ambient. CONTEXT.md:24 calls it a branding agent;
 *     that line is the outlier and both persona files disagree with it.
 *   - Solara and Helios are deployed inside a client tenant, so they are
 *     marked "scoped" rather than presented as OASIS-wide staff.
 *   - No client is named. Hermes ships to a specific customer; it is
 *     described by what it does, never by who bought it.
 */

export type FleetState = "live" | "scoped";

export type FleetMember = {
  /** Uppercase callsign — the roster's primary key and its visual anchor. */
  callsign: string;
  /** The seat, in business language. Not a job title we invented for the web. */
  seat: string;
  /** Short right-aligned status text in the roster row. */
  readout: string;
  state: FleetState;
  /** One sentence. What it is for, from the client's side of the screen. */
  summary: string;
  /** What it actually does, concretely. Verbs, not adjectives. */
  duties: string[];
  /** One real artifact it produces. Makes the whole card falsifiable. */
  artifact: string;
};

export const FLEET: FleetMember[] = [
  {
    callsign: "BRAVO",
    seat: "Operations · Engineering",
    readout: "on watch",
    state: "live",
    summary:
      "The one that runs everything else. Bravo plans the work, writes the code, ships it, and reports what changed.",
    duties: [
      "Builds and deploys the systems the rest of the fleet runs on",
      "Holds the state of every project and picks up where the last session stopped",
      "Routes work to the right specialist and checks it before you see it",
      "Blocks its own destructive commands behind guardrails it cannot bypass",
    ],
    artifact:
      "A shipped pull request, with the test output that proves it works attached.",
  },
  {
    callsign: "MAVEN",
    seat: "Content · Brand · Demand",
    readout: "on request",
    state: "live",
    summary:
      "Writes in your voice, not a model's. Maven handles the words your business puts in front of people.",
    duties: [
      "Drafts posts, emails, landing copy, and ad variants from one brief",
      "Keeps a brand voice consistent across every channel",
      "Builds funnels and the sequences that follow up behind them",
      "Assembles proposals and decks from real project data",
    ],
    artifact: "A scheduled month of content that sounds like you wrote it.",
  },
  {
    callsign: "ATLAS",
    seat: "Finance · Reporting",
    readout: "on request",
    state: "live",
    summary:
      "Every money question goes to one place. Atlas owns the numbers so nobody else guesses at them.",
    duties: [
      "Reconciles revenue across payment processors and accounts",
      "Tracks recurring revenue, overhead, and runway",
      "Prepares tax and bookkeeping positions ahead of deadlines",
      "Answers 'can we afford this' with the actual figure",
    ],
    artifact: "A month-end position you can act on without opening a spreadsheet.",
  },
  {
    callsign: "LEX",
    seat: "Contracts · Risk review",
    readout: "on request",
    state: "live",
    summary:
      "Reads the agreement before you sign it and tells you, in plain English, which clauses will cost you.",
    duties: [
      "Reviews contracts and ranks the risks by what they actually expose",
      "Drafts agreements from your terms, not a template's",
      "Flags the clause a counterparty is counting on you skimming",
      "Stops short of legal advice, every time, by design",
    ],
    artifact: "A redline with the deal-breakers separated from the noise.",
  },
  {
    callsign: "AURA",
    seat: "Voice · Ambient",
    readout: "on watch",
    state: "live",
    summary:
      "The fleet out loud. Aura is how the operation talks to you when you are not at a keyboard.",
    duties: [
      "Delivers the morning brief and the end-of-day debrief as voice",
      "Carries alerts to you wherever you are, not to a dashboard nobody opens",
      "Connects the ambient layer: home, devices, environment",
    ],
    artifact: "A ninety-second voice note that replaces reading a status page.",
  },
  {
    callsign: "SOLARA",
    seat: "Client operations",
    readout: "tenant-scoped",
    state: "scoped",
    summary:
      "A deployed operations agent that lives inside one client's business and runs their pipeline.",
    duties: [
      "Packages applications and matches them to the right counterparties",
      "Reports pipeline status to the team that owns it",
      "Runs renewal sweeps so nothing ages out unnoticed",
      "Never drafts outreach. That is a separate seat, on purpose",
    ],
    artifact: "A day's pipeline, packaged and routed, before the team logs in.",
  },
  {
    callsign: "HELIOS",
    seat: "Client outreach",
    readout: "tenant-scoped",
    state: "scoped",
    summary:
      "The other half of a deployed pair: the voice that talks to a client's prospects, under hard compliance limits.",
    duties: [
      "Qualifies inbound interest by asking, not pitching",
      "Runs revival sequences on leads that went quiet",
      "Operates inside messaging-compliance guardrails it cannot override",
      "Never puts a number in writing it is not authorised to offer",
    ],
    artifact: "A qualified conversation handed to a human at the right moment.",
  },
];

/**
 * What actually makes this work where a chatbot doesn't.
 *
 * Every claim maps to something real in this codebase — the state DB, the
 * PreToolUse guard chain, the event bus, per-tenant RLS, the model
 * registry, the approval gates. Written from the client's side of the
 * screen, so no component or table names, but nothing here is aspirational.
 */
export const DIFFERENTIATORS = [
  {
    title: "It remembers",
    body: "State persists between sessions. Ask on Thursday what changed on Monday and it knows, because it was the one that changed it. No re-briefing, no pasting last week's context back in, no starting over because the tab closed.",
  },
  {
    title: "It can't be talked past",
    body: "The guardrails sit underneath the agent, in the layer that actually executes. Destructive commands, credential reads, and outbound sends are stopped by code the model never sees and cannot argue with. Safety that depends on the model choosing to behave is not safety.",
  },
  {
    title: "They hand work to each other",
    body: "Shared state and an event bus between seats. Operations ships something, Finance sees the cost, Marketing gets the announcement. All from one instruction, without you carrying the output of one tool into the input of the next.",
  },
  {
    title: "It runs on your data, in your infrastructure",
    body: "Your database, your account, row-level access control per tenant. Nothing is pooled with another client's data. If you ever stop working with us you keep the system running, because it was always yours.",
  },
  {
    title: "It isn't married to one model",
    body: "Work routes across providers on cost and capability, and sensitive jobs can run on a model hosted on your own hardware. The frontier moves every few months. You get the upgrade without a rebuild.",
  },
  {
    title: "You choose the leash",
    body: "Autonomy is scoped per action, not granted once. Draft freely but never send. Read every account but never move money. Anything that spends, signs, or leaves the building stops for a human unless you say otherwise.",
  },
] as const;

/**
 * The economic argument, in three moves. Deliberately free of numbers:
 * pricing is not settled (see /work) and an invented ROI figure is the
 * fastest way to lose a reader who does this arithmetic for a living.
 */
export const ECONOMICS = [
  {
    label: "Time",
    headline: "The schedule stops needing a person",
    body: "The follow-up. The report. The reconciliation. The chase. Work that runs on a cadence stops consuming a human on that cadence, and you get back the hours that were never the reason you started the business.",
  },
  {
    label: "Cost",
    headline: "A seat costs the same at any volume",
    body: "Ten jobs or ten thousand, the seat costs what the seat costs. Payroll does not work that way, and neither does per-seat SaaS priced against a headcount you are trying not to grow.",
  },
  {
    label: "Scale",
    headline: "Growth stops meaning hiring",
    body: "The ceiling moves from how many people you can afford and manage to how much work you can clearly define. That is a different business, one where taking on more clients is a decision rather than a hiring round.",
  },
] as const;

/**
 * Products built as agents FOR clients, rather than seats in the OASIS
 * fleet. Kept separate because conflating "our staff" with "what we built
 * for someone else" is the fastest way to make both claims untrustworthy.
 */
export const CLIENT_BUILDS = [
  {
    name: "Commerce back office",
    summary:
      "A wholesale operation's order desk, run end to end: purchase orders parsed out of PDFs, spreadsheets and EDI, entered into the desktop ERP, invoiced, and confirmed by email.",
    proof: "Runs local-first. Customer data never leaves the client's machine.",
  },
  {
    name: "Funding operator portal",
    summary:
      "A lending team's whole pipeline: applications in, documents extracted, underwriting graded from real bank statements, and offers routed to the right funders.",
    proof: "Grades revenue from statements rather than trusting the stated figure.",
  },
  {
    name: "Tenant-screening platform",
    summary:
      "A property operator's screening and leasing flow, with per-role access, document handling, and the reminder logic that stops renewals slipping.",
    proof: "Row-level security on every table, verified by an automated isolation audit.",
  },
];
