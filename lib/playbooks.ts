/**
 * Playbook markdown (content/playbooks/*.md), bundled into the Worker.
 *
 * The markdown is compiled into lib/playbooks.generated.ts by
 * scripts/gen-content-modules.mjs (run by `prebuild`, committed, and checked
 * for drift by tests/playbook-docs.test.ts). This module never touches a
 * filesystem: the production Worker has none, and the previous runtime
 * readdir/readFile answered [] / null there, which is how
 * /playbook/10-oasis-loop showed "Page not found" and the Operating manual
 * section disappeared (audit 2026-09-30, playbook-fs-reads-on-workers).
 *
 * NOTHING IS SWALLOWED. A slug that is not in the bundle is a real "no such
 * playbook": loadPlaybook throws PlaybookNotFoundError, and the page maps that
 * one error to a 404. Any other failure propagates.
 *
 * Frontmatter: an optional leading `---` block. `updated: YYYY-MM-DD` is the
 * date the document's content was last reviewed; it is shown as the source
 * date and never guessed when absent.
 */

import { PLAYBOOK_SOURCES } from "./playbooks.generated";

export type PlaybookSlug = string;

export type PlaybookFile = {
  slug: PlaybookSlug;
  title: string;
  body: string;
  audience: "operator" | "client" | "internal";
  /** `updated:` from the frontmatter, YYYY-MM-DD, or null when not recorded. */
  updated: string | null;
};

export class PlaybookNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`No bundled playbook "${slug}" (content/playbooks/${slug}.md is not in lib/playbooks.generated.ts)`);
    this.name = "PlaybookNotFoundError";
  }
}

// Audience inferred from an "Audience:" line or known wording. Keeps the
// content files free of required frontmatter while letting the index filter.
function inferAudience(slug: string, body: string): PlaybookFile["audience"] {
  const explicitAudience = body.match(/^\**Audience:\**\s*(.+?)\s*$/im)?.[1]?.toLowerCase() || "";
  if (explicitAudience.includes("client")) return "client";
  if (explicitAudience.includes("customer")) return "client";
  if (explicitAudience.includes("operator")) return "operator";
  if (explicitAudience.includes("internal")) return "internal";
  const lowered = `${slug} ${body.slice(0, 200)}`.toLowerCase();
  if (lowered.includes("customer-facing") || lowered.includes("verbatim script")) return "client";
  if (lowered.includes("internal-only") || lowered.includes("operator dev")) return "internal";
  return "operator";
}

function extractTitle(body: string, fallback: string): string {
  const firstH1 = body.match(/^#\s+(.+?)\s*$/m);
  return firstH1?.[1]?.trim() || fallback;
}

function frontmatterOf(raw: string): { block: string; rest: string } {
  const fm = raw.startsWith("---") ? raw.match(/^---\n[\s\S]*?\n---\n?/) : null;
  return fm ? { block: fm[0], rest: raw.slice(fm[0].length) } : { block: "", rest: raw };
}

function updatedOf(block: string): string | null {
  const v = block.match(/^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
  return v ?? null;
}

/**
 * Strip what should not render: the frontmatter block and a standalone
 * "Audience: ..." line. Title and audience are read from the raw file first.
 */
function stripForDisplay(rest: string): string {
  return rest.replace(/^[ \t]*\**Audience:\**[^\n]*\n+/im, "").replace(/^\s+/, "");
}

function toFile(file: string, raw: string): PlaybookFile {
  const slug = file.replace(/\.md$/, "");
  const { block, rest } = frontmatterOf(raw);
  return {
    slug,
    title: extractTitle(rest, slug),
    body: stripForDisplay(rest),
    audience: inferAudience(slug, rest),
    updated: updatedOf(block),
  };
}

const FILES: readonly PlaybookFile[] = PLAYBOOK_SOURCES.map((s) => toFile(s.file, s.raw));
const BY_SLUG = new Map(FILES.map((f) => [f.slug, f]));

/** Every bundled playbook, in file-name order. */
export function listPlaybooks(): PlaybookFile[] {
  return [...FILES];
}

/** The bundled playbook `slug`. Throws PlaybookNotFoundError when there is none. */
export function loadPlaybook(slug: PlaybookSlug): PlaybookFile {
  const file = /^[a-zA-Z0-9_-]+$/.test(slug) ? BY_SLUG.get(slug) : undefined;
  if (!file) throw new PlaybookNotFoundError(slug);
  return file;
}
