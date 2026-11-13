/**
 * lib/site-scan/types.ts — the shapes the free AI scan stores and serves.
 *
 * Three JSON documents live on a site_scans row, each versioned by a `schema` field so the
 * Python enricher (Business-Empire-Agent/scripts/site_scan) and this Worker can evolve apart:
 *
 *   facts_json      Tier 0, written by the Worker: what the site itself says and measures.
 *   score_json      Tier 0, written by the Worker: the OASIS score and the three fixes.
 *   enrich_json     Tier 1, written back by the runner: category, buyer segments, competitors,
 *                   sample prospects, email authentication. Our own data and local ML only.
 *   narrative_json  Tier 1 (template) or Tier 2 (model polish): the analyst's sentences.
 *
 * Nothing here is a model's opinion by default. Every sentence in the narrative must trace to a
 * fact in facts_json or enrich_json; the templates in scripts/site_scan/narrative.py enforce it.
 */
import type { PageSpeedResult } from "@/lib/ai-audit/pagespeed";
import type { SiteCheck } from "@/lib/ai-audit/site-checks";
import type { SiteReport } from "@/lib/ai-audit/site-fetch";

export const FACTS_SCHEMA = "site_scan/facts/v1" as const;
export const SCORE_SCHEMA = "site_scan/score/v1" as const;
export const ENRICH_SCHEMA = "site_scan/enrich/v1" as const;
export const NARRATIVE_SCHEMA = "site_scan/narrative/v1" as const;

/** The stages the public page draws, in order. */
export const SCAN_STAGES = ["read", "health", "profile", "segments", "prospects", "email", "score", "done"] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];
export type ScanStatus = "queued" | "reading" | "enriching" | "done" | "failed";

export const STAGE_TITLES: Readonly<Record<ScanStage, string>> = {
  read: "Reading your site",
  health: "Measuring site health",
  profile: "Learning what you sell",
  segments: "Working out who buys it",
  prospects: "Finding businesses like your buyers",
  email: "Writing a first email",
  score: "Scoring and prioritising fixes",
  done: "Report ready",
};

/** What the site says about itself, read from its own pages. Every field is observed, never inferred. */
export type SiteSignals = {
  title: string | null;
  meta_description: string | null;
  h1: string[];
  og_site_name: string | null;
  language: string | null;
  /** The best name for the business: og:site_name, else the title before a separator, else the domain. */
  business_name: string;
  /** A one-line promise: the first H1, else the meta description, else the title's tail. */
  tagline: string | null;
  phones: string[];
  emails: string[];
  /** City / region words seen in schema.org address, footer or contact page. */
  localities: string[];
  /** Service or product names: nav labels, services-page headings, schema.org offers. */
  services: string[];
  pricing_mentioned: boolean;
  booking_tools: string[];
  forms_count: number;
  chat_tools: string[];
  analytics: string[];
  socials: Record<string, string>;
  schema_types: string[];
  copyright_year: number | null;
  blog: { found: boolean; latest_date: string | null };
  images_total: number;
  images_missing_alt: number;
  internal_links: number;
  external_links: number;
  cta_phrases: string[];
  /** The most frequent meaningful words across the pages read (stopwords removed). */
  keywords: Array<{ term: string; count: number }>;
  word_count: number;
  /** Visible text of the pages read, capped, for the enricher's embeddings. */
  text_excerpt: string;
};

export type ScanFacts = {
  schema: typeof FACTS_SCHEMA;
  domain: string;
  start_url: string;
  final_url: string | null;
  read_at: string;
  site: {
    unread: SiteReport["unread"];
    pages_read: number;
    notes: string[];
    https_served: boolean;
    response_ms: number | null;
    html_kb: number | null;
    /**
     * The Worker read the site but found almost no text: a page drawn by JavaScript, or a shell. The
     * runner reads it in a real browser before it matches (lib/site-scan/browser-read.ts). Set by
     * Tier 0 only, so a browser read that is thin too is not read again.
     */
    thin?: boolean;
  };
  checks: SiteCheck[];
  pagespeed: PageSpeedResult | null;
  signals: SiteSignals | null;
};

export type ScorePillar = {
  key: "conversion" | "speed" | "trust" | "findability" | "reach";
  label: string;
  /** 0-100 within the pillar; null when too little of it could be read to say (never a 0 for "unknown"). */
  score: number | null;
  /** Share of the total, in hundredths (the five sum to 100). */
  weight: number;
  detail: string;
};

export type ScanFix = {
  key: string;
  title: string;
  why: string;
  /** The OASIS automation or build that solves it (lib/website-sales.ts sell menu key when one applies). */
  automation: string;
  /** Points the total would gain if fixed, as scored today. */
  impact: number;
};

export type ScanScore = {
  schema: typeof SCORE_SCHEMA;
  /** 0-100 over the pillars that could be scored; null when the evidence is too thin to score the site at all. */
  total: number | null;
  pillars: ScorePillar[];
  fixes: ScanFix[];
};

export type ScanSegment = { key: string; label: string; fit: number; why: string };
/** Where a matched business came from (engine 2.0): the Overture map, OpenStreetMap, or OASIS's own directory. */
export type MatchSource = "overture" | "osm" | "directory";
/** Measured from the scanned business (engine 2.0, when it was located): km, and a compass bearing. */
type Placed = { country?: string | null; distance_km?: number | null; bearing_deg?: number | null; source?: MatchSource | null };
export type ScanCompetitor = { name: string; domain: string | null; locality: string | null } & Placed;
export type ScanProspect = {
  name: string;
  locality: string | null;
  region: string | null;
  domain: string | null;
  category_label: string;
  why: string;
} & Placed;
/** Where the scanned business is (engine 2.0): its own map listing, or a geocode of its address or town. */
export type ScanLocation = { lat: number; lon: number; country: string | null; locality: string | null; source: string };
/** A data source the matches came from, with the attribution its licence asks for. */
export type ScanSource = { key: string; label: string; note: string };

export type ScanEnrich = {
  schema: typeof ENRICH_SCHEMA;
  engine: { embedder: string; version: string };
  category: { key: string; label: string; confidence: number } | null;
  keywords: string[];
  segments: ScanSegment[];
  competitors: ScanCompetitor[];
  prospects: ScanProspect[];
  email_auth: { mx: boolean | null; spf: boolean | null; dmarc: boolean | null } | null;
  notes: string[];
  location?: ScanLocation | null;
  sources?: ScanSource[];
};

export type ScanNarrative = {
  schema: typeof NARRATIVE_SCHEMA;
  source: "template" | "model";
  what_you_sell: string;
  who_buys: string;
  competitors_note: string | null;
  fixes_intro: string;
  email: { to: string | null; subject: string; body: string } | null;
};

export type ScanRow = {
  id: string;
  tenantId: string;
  domain: string;
  url: string;
  status: ScanStatus;
  stage: ScanStage;
  facts: ScanFacts | null;
  score: ScanScore | null;
  enrich: ScanEnrich | null;
  narrative: ScanNarrative | null;
  errorCode: string | null;
  outcome: "none" | "claimed" | "booked" | "bought";
  leadRecordId: string | null;
  engagementId: string | null;
  createdAt: string;
  updatedAt: string;
  enrichedAt: string | null;
};

/** What the public page receives. Never the ip hash, never the lead id. */
export type ScanView = {
  id: string;
  domain: string;
  url: string;
  status: ScanStatus;
  stages: Array<{ key: ScanStage; title: string; state: "done" | "running" | "pending" | "skipped" }>;
  facts: ScanFacts | null;
  score: ScanScore | null;
  enrich: ScanEnrich | null;
  narrative: ScanNarrative | null;
  claimed: boolean;
  error: string | null;
  created_at: string;
};

export const SCAN_TTL_DAYS = 30;
export const ENRICH_WAIT_MINUTES = 20;
