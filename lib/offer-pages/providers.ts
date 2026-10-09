/**
 * lib/offer-pages/providers.ts - video links (YouTube, Vimeo, Loom) and the
 * video refs a page carries. Pure: the builder, the page and the routes share it.
 *
 * WHAT A LINK MAY BE (design section 4.2). Exactly these shapes, on exactly
 * these hosts:
 *
 *   YouTube  youtube.com/watch?v=<11>   youtu.be/<11>   youtube.com/shorts/<11>
 *            youtube.com/embed/<11>      (www., m. and youtube-nocookie.com too)
 *   Vimeo    vimeo.com/<digits>          vimeo.com/<digits>/<hash> (unlisted)
 *            player.vimeo.com/video/<digits>[?h=<hash>]
 *   Loom     loom.com/share/<32 hex>     (www. too)
 *
 * Every other host, scheme or shape is refused: a lookalike host
 * (youtube.com.evil.test), credentials in the URL, a port, javascript:, extra
 * path segments. A link becomes an id here, and the page only ever builds the
 * player URL from that id (embedUrl), so nothing a person pasted reaches an
 * iframe as typed.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import type { LinkVideoRef, OfferPageDoc, VideoRef } from "./types";
import { isProviderId, isVimeoHash } from "./types";

export type ParsedVideoLink =
  | { ok: true; source: LinkVideoRef["source"]; id: string; hash?: string; vertical: boolean; canonical: string }
  | { ok: false; reason: string };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com"]);
const LOOM_HOSTS = new Set(["loom.com", "www.loom.com"]);

const REFUSED = "Paste a YouTube, Vimeo or Loom link to one video.";

/** A pasted video link, as an id the page can play, or the reason it is refused. */
export function parseVideoLink(input: string): ParsedVideoLink {
  let raw = String(input || "").trim();
  if (!raw || raw.length > 500) return { ok: false, reason: REFUSED };
  // "youtu.be/abc" with no scheme is how people paste; anything with a scheme
  // other than http(s) is refused below.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: REFUSED };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: REFUSED };
  if (u.username || u.password || u.port) return { ok: false, reason: REFUSED };
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);

  if (YOUTUBE_HOSTS.has(host)) {
    let id: string | null = null;
    let vertical = false;
    if (segs.length === 1 && segs[0] === "watch") id = u.searchParams.get("v");
    else if (segs.length === 2 && segs[0] === "shorts") {
      id = segs[1];
      vertical = true;
    } else if (segs.length === 2 && segs[0] === "embed") id = segs[1];
    if (!id || !isProviderId("youtube", id)) return { ok: false, reason: REFUSED };
    return { ok: true, source: "youtube", id, vertical, canonical: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === "youtu.be") {
    const id = segs.length === 1 ? segs[0] : null;
    if (!id || !isProviderId("youtube", id)) return { ok: false, reason: REFUSED };
    return { ok: true, source: "youtube", id, vertical: false, canonical: `https://www.youtube.com/watch?v=${id}` };
  }
  if (VIMEO_HOSTS.has(host)) {
    if (segs.length < 1 || segs.length > 2) return { ok: false, reason: REFUSED };
    const id = segs[0];
    const hash = segs[1];
    if (!isProviderId("vimeo", id)) return { ok: false, reason: REFUSED };
    if (hash !== undefined && !isVimeoHash(hash)) return { ok: false, reason: REFUSED };
    return {
      ok: true,
      source: "vimeo",
      id,
      ...(hash ? { hash } : {}),
      vertical: false,
      canonical: `https://vimeo.com/${id}${hash ? `/${hash}` : ""}`,
    };
  }
  if (host === "player.vimeo.com") {
    if (segs.length !== 2 || segs[0] !== "video" || !isProviderId("vimeo", segs[1])) return { ok: false, reason: REFUSED };
    const h = u.searchParams.get("h");
    if (h !== null && !isVimeoHash(h)) return { ok: false, reason: REFUSED };
    return {
      ok: true,
      source: "vimeo",
      id: segs[1],
      ...(h ? { hash: h } : {}),
      vertical: false,
      canonical: `https://vimeo.com/${segs[1]}${h ? `/${h}` : ""}`,
    };
  }
  if (LOOM_HOSTS.has(host)) {
    if (segs.length !== 2 || segs[0] !== "share" || !isProviderId("loom", segs[1])) return { ok: false, reason: REFUSED };
    return { ok: true, source: "loom", id: segs[1], vertical: false, canonical: `https://www.loom.com/share/${segs[1]}` };
  }
  return { ok: false, reason: REFUSED };
}

/**
 * The player URL a facade inserts on tap, built only from a validated id.
 * Autoplay, because the tap was the visitor asking it to play.
 */
export function embedUrl(ref: Pick<LinkVideoRef, "source" | "id" | "hash">): string | null {
  if (!isProviderId(ref.source, ref.id)) return null;
  if (ref.source === "youtube") {
    return `https://www.youtube-nocookie.com/embed/${ref.id}?autoplay=1&rel=0&playsinline=1`;
  }
  if (ref.source === "vimeo") {
    const h = ref.hash && isVimeoHash(ref.hash) ? `h=${ref.hash}&` : "";
    return `https://player.vimeo.com/video/${ref.id}?${h}autoplay=1&dnt=1`;
  }
  return `https://www.loom.com/embed/${ref.id}?autoplay=1`;
}

/** The provider's own page for a link video (the oEmbed lookup and the builder's "open" link). */
export function canonicalUrl(ref: Pick<LinkVideoRef, "source" | "id" | "hash">): string {
  if (ref.source === "youtube") return `https://www.youtube.com/watch?v=${ref.id}`;
  if (ref.source === "vimeo") return `https://vimeo.com/${ref.id}${ref.hash ? `/${ref.hash}` : ""}`;
  return `https://www.loom.com/share/${ref.id}`;
}

/** iframe permissions for a provider player. */
export const PLAYER_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";

/**
 * Where a video sits on a page: "hero", "what_you_get:<i>", "work:<i>" or
 * "results:<i>", with i the item's index in the DOCUMENT (never in what was
 * drawn), so a ref means the same item to the page, the builder and the
 * signing route.
 */
export const VIDEO_REF_RE = /^(hero|(what_you_get|work|results):([0-9]{1,2}))$/;

export type VideoAt = { ref: string; video: VideoRef };

/** Every video a document carries, with its ref. */
export function videoRefs(doc: OfferPageDoc): VideoAt[] {
  const out: VideoAt[] = [];
  if (doc.hero.video) out.push({ ref: "hero", video: doc.hero.video });
  for (const s of doc.sections) {
    if (s.key === "what_you_get") {
      s.items.forEach((item, i) => {
        if (item.video) out.push({ ref: `what_you_get:${i}`, video: item.video });
      });
    } else if (s.key === "work") {
      s.items.forEach((item, i) => {
        out.push({ ref: `work:${i}`, video: item.video });
      });
    } else if (s.key === "results") {
      s.items.forEach((item, i) => {
        if (item.kind === "video") out.push({ ref: `results:${i}`, video: item.video });
      });
    }
  }
  return out;
}

/** The video at `ref` in this document, or null. */
export function findVideoRef(doc: OfferPageDoc, ref: string): VideoRef | null {
  if (!VIDEO_REF_RE.test(ref)) return null;
  return videoRefs(doc).find((v) => v.ref === ref)?.video ?? null;
}

/** "4:12" for 252 seconds; "" when unknown. */
export function formatDuration(seconds: number | undefined | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rest = String(s % 60).padStart(2, "0");
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${rest}`;
  return `${m}:${rest}`;
}
