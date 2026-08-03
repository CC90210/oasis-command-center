/**
 * ingest-core — what happens when Adon drops a link into the Train screen.
 *
 * PURE. No imports, no network, no DB. Every decision here is testable with a
 * string, which matters because this is the front door of the training system:
 * misclassify a URL and the wrong extractor runs, or the dedupe key collides and
 * two ingests fight over one row.
 *
 * Adon, 2026-08-03: "we want to be able to create a system that trains itself
 * based off of video links, GitHub repo, stuff like that. I can just drag and
 * drop the link right in and you'll automatically be able to ingest that and
 * also be able to replicate certain videos and take inspiration from certain
 * videos to create ads."
 *
 * So: paste anything, we work out what it is, canonicalise it, and queue the
 * right kind of extraction.
 */

export const SOURCE_KINDS = [
  "youtube",
  "instagram",
  "tiktok",
  "github",
  "web",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What the ingest worker should try to pull out of this source. */
export const EXTRACTORS = ["video", "repo", "article"] as const;
export type Extractor = (typeof EXTRACTORS)[number];

export type IngestTarget = {
  kind: SourceKind;
  extractor: Extractor;
  /** Canonical URL — the dedupe identity. Tracking params stripped. */
  canonicalUrl: string;
  /** Platform-native id when we can name one (video id, owner/repo). */
  externalId: string | null;
  /** Human label for the queue row before extraction fills in a real title. */
  label: string;
  /** True when this source can plausibly become an ad reference. */
  inspirable: boolean;
};

export type IngestParseResult =
  | { ok: true; target: IngestTarget }
  | { ok: false; reason: string };

/**
 * Query params that identify a resource vs. params that only track who clicked.
 * Stripping the latter is what makes the same video pasted from two places
 * dedupe to one corpus row instead of two.
 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "igshid", "igsh", "si", "feature", "app", "_r", "_t",
  "ref", "ref_src", "source", "share_id", "referrer", "mibextid",
]);

function stripTracking(u: URL): URL {
  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }
  u.hash = "";
  return u;
}

function host(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
}

/**
 * Accepts what a human actually pastes: bare domains, a URL with surrounding
 * whitespace, a link copied out of a share sheet. Rejects anything that is not
 * http(s) — a `javascript:` or `data:` URL must never reach a fetcher.
 */
export function normalizeUrl(raw: string): URL | null {
  const trimmed = (raw || "").trim().replace(/^<|>$/g, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.includes(".")) return null;
  return stripTracking(u);
}

/** Classify a pasted link and canonicalise it. */
export function parseIngestUrl(raw: string): IngestParseResult {
  const u = normalizeUrl(raw);
  if (!u) return { ok: false, reason: "That does not look like a link." };
  const h = host(u);
  const seg = u.pathname.split("/").filter(Boolean);

  // ── YouTube ────────────────────────────────────────────────────────
  if (h === "youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com") {
    let id: string | null = null;
    if (h === "youtu.be") id = seg[0] || null;
    else if (seg[0] === "shorts" || seg[0] === "embed" || seg[0] === "live") id = seg[1] || null;
    else if (u.pathname === "/watch") id = u.searchParams.get("v");
    if (!id) {
      return { ok: false, reason: "YouTube link has no video id — paste a watch, shorts or youtu.be link." };
    }
    return {
      ok: true,
      target: {
        kind: "youtube",
        extractor: "video",
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
        externalId: id,
        label: `YouTube ${id}`,
        inspirable: true,
      },
    };
  }

  // ── Instagram ──────────────────────────────────────────────────────
  if (h === "instagram.com" || h === "instagr.am" || h === "ddinstagram.com") {
    // /reel/<code>, /p/<code>, /tv/<code>, and /<user>/reel/<code>
    const i = seg.findIndex((s) => s === "reel" || s === "reels" || s === "p" || s === "tv");
    const code = i >= 0 ? seg[i + 1] : null;
    if (!code) {
      // A bare profile link is still useful — it is an account to learn from.
      if (seg.length === 1) {
        return {
          ok: true,
          target: {
            kind: "instagram",
            extractor: "article",
            canonicalUrl: `https://www.instagram.com/${seg[0]}/`,
            externalId: seg[0],
            label: `Instagram @${seg[0]}`,
            inspirable: false,
          },
        };
      }
      return { ok: false, reason: "Instagram link has no post code — paste a reel or post URL." };
    }
    const isReel = seg[i] === "reel" || seg[i] === "reels";
    return {
      ok: true,
      target: {
        kind: "instagram",
        extractor: "video",
        canonicalUrl: `https://www.instagram.com/${isReel ? "reel" : seg[i]}/${code}/`,
        externalId: code,
        label: `Instagram ${isReel ? "reel" : "post"} ${code}`,
        inspirable: true,
      },
    };
  }

  // ── TikTok ─────────────────────────────────────────────────────────
  if (h === "tiktok.com" || h === "vm.tiktok.com" || h === "vt.tiktok.com") {
    const vi = seg.indexOf("video");
    const id = vi >= 0 ? seg[vi + 1] : null;
    const user = seg.find((s) => s.startsWith("@"));
    if (id && user) {
      return {
        ok: true,
        target: {
          kind: "tiktok",
          extractor: "video",
          canonicalUrl: `https://www.tiktok.com/${user}/video/${id}`,
          externalId: id,
          label: `TikTok ${id}`,
          inspirable: true,
        },
      };
    }
    // vm./vt. short links cannot be resolved without a network hop; keep them
    // and let the worker follow the redirect rather than rejecting the paste.
    return {
      ok: true,
      target: {
        kind: "tiktok",
        extractor: "video",
        canonicalUrl: u.toString(),
        externalId: null,
        label: "TikTok link (unresolved short URL)",
        inspirable: true,
      },
    };
  }

  // ── GitHub ─────────────────────────────────────────────────────────
  if (h === "github.com") {
    const [owner, repo] = seg;
    if (owner && repo) {
      return {
        ok: true,
        target: {
          kind: "github",
          extractor: "repo",
          canonicalUrl: `https://github.com/${owner}/${repo}`,
          externalId: `${owner}/${repo}`,
          label: `${owner}/${repo}`,
          inspirable: false,
        },
      };
    }
    if (owner) {
      return {
        ok: true,
        target: {
          kind: "github",
          extractor: "repo",
          canonicalUrl: `https://github.com/${owner}`,
          externalId: owner,
          label: `GitHub @${owner}`,
          inspirable: false,
        },
      };
    }
    return { ok: false, reason: "GitHub link has no owner or repo." };
  }

  // ── anything else ──────────────────────────────────────────────────
  return {
    ok: true,
    target: {
      kind: "web",
      extractor: "article",
      canonicalUrl: u.toString(),
      externalId: null,
      label: h + (seg.length ? `/${seg[0]}` : ""),
      inspirable: false,
    },
  };
}

/**
 * What the UI tells the operator will happen, before they commit. Ingestion is
 * asynchronous and can take a while; saying so up front is the difference
 * between "queued" reading as progress and reading as broken.
 */
export function describeExtraction(t: IngestTarget): string {
  switch (t.extractor) {
    case "video":
      return t.kind === "instagram" || t.kind === "tiktok"
        ? "Pull the caption, on-screen text and pacing, then break down why the hook works."
        : "Pull the transcript and chapter structure, then break down the hook and pacing.";
    case "repo":
      return "Read the README and structure, then summarise what it does and what is worth borrowing.";
    case "article":
      return "Pull the readable text, then summarise the angle and any claims worth reusing.";
  }
}

/**
 * Dedupe identity for the corpus. Matches the partial unique index in
 * migration 133 on (tenant_id, source_url) where state in ('queued','extracting'),
 * so the DB refuses a second in-flight ingest of the same source rather than
 * relying on a read-then-insert check that two concurrent pastes could both pass.
 */
export function ingestDedupeKey(t: IngestTarget): string {
  return t.canonicalUrl;
}

/** Corpus labels an operator can assign. See migration 133's `label` CHECK. */
export const CORPUS_LABELS = ["exemplar", "counter_example", "neutral"] as const;
export type CorpusLabel = (typeof CORPUS_LABELS)[number];

export const CORPUS_LABEL_COPY: Record<CorpusLabel, { title: string; help: string }> = {
  exemplar: {
    title: "Do more of this",
    help: "Maven should treat this as a model to work toward.",
  },
  counter_example: {
    title: "Never do this",
    help: "The scarcer and more useful of the two — it draws a boundary.",
  },
  neutral: {
    title: "Just context",
    help: "Background knowledge, not a judgement about quality.",
  },
};

/** Ingest lifecycle, matching marketing_corpus.state. */
export const INGEST_STATES = ["queued", "extracting", "indexed", "failed", "skipped"] as const;
export type IngestState = (typeof INGEST_STATES)[number];

export function ingestStateCopy(s: IngestState): { label: string; tone: "pending" | "active" | "done" | "bad" } {
  switch (s) {
    case "queued":
      return { label: "Waiting", tone: "pending" };
    case "extracting":
      return { label: "Reading it", tone: "active" };
    case "indexed":
      return { label: "Learned", tone: "done" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    case "skipped":
      return { label: "Skipped", tone: "bad" };
  }
}

/**
 * Split a blob of pasted text into candidate links. Drag-and-drop and paste both
 * hand over arbitrary text, and Adon pasting five links at once should enqueue
 * five items, not fail on "that is not a URL".
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Two shapes, because both get pasted:
  //   1. scheme- or www-prefixed        https://… / www.…
  //   2. bare host WITH a path          github.com/owner/repo
  // The path slash in (2) is load-bearing: without it the pattern would also
  // match ordinary prose like "Node.js", "e.g." or "Inc.".
  const RE =
    /(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\/[^\s<>"')\]]*/gi;
  for (const m of text.matchAll(RE)) {
    const cleaned = m[0].replace(/[.,;:!?]+$/, "");
    const parsed = normalizeUrl(cleaned);
    if (!parsed) continue;
    const key = parsed.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}
