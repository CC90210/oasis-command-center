/**
 * lib/offer-pages/render.ts - everything the public page needs, prepared on
 * the server: what is drawn, and the media each drawn video and image shows.
 *
 * The page component (components/offer-pages/OfferPage.tsx) is then plain
 * presentation over this, which is what lets the tests render it.
 *
 *   - A link video is playable by construction; its poster is OUR copy of the
 *     provider thumbnail (public tenant-assets), and its player URL is built
 *     from the validated id. Nothing third-party loads before a tap.
 *   - A Library video is drawn only when it resolves for the form's own
 *     workspace (lib/offer-pages/video.ts). Its poster is signed (an hour plus
 *     the presign window); the video file is never in the page.
 *   - Anything that does not resolve is simply not drawn (section 4.5): the
 *     headline and the booking still are.
 */
import type { Client } from "@libsql/client";
import type { Aspect, OfferPageDoc, TemplateKey } from "./types";
import { DEFAULT_ACCENT } from "./types";
import { drawnPage, type DrawnPage, type MediaCheck } from "./visibility";
import { embedUrl, formatDuration } from "./providers";
import { imageKey, ownThumbPath, resolveDocLibrary, signPageMedia, type ResolvedLibrary, type Signer } from "./video";

export type FacadeMedia = {
  source:
    | { kind: "link"; embedSrc: string }
    // preview: the owner's signed-in preview of the DRAFT, signed by the
    // builder's own route (it reads the draft); absent on the public page.
    | { kind: "library"; formId: string; videoRef: string; captions: boolean; preview?: true };
  posterUrl: string | null;
  posterWidth: number | null;
  posterHeight: number | null;
  aspect: Aspect;
  duration: string;
};

export type PreparedOffer = {
  page: DrawnPage;
  accent: string;
  ctaLabel: string;
  /** Per drawn video ref. */
  media: Record<string, FacadeMedia>;
  /** Per Library image ("asset|media"). */
  images: Record<string, { url: string; width: number | null; height: number | null }>;
};

/** A neutral button label per template: navigation words, never a claim. */
export const DEFAULT_CTA: Readonly<Record<TemplateKey, string>> = {
  book_call: "Book a call",
  free_audit: "Get started",
  application: "Apply now",
};

export async function prepareOfferRender(input: {
  db: Client | null;
  tenantId: string;
  formId: string;
  doc: OfferPageDoc;
  fallbackHeadline: string;
  sign: Signer;
  /** Public URL of an object in the public tenant-assets prefix. */
  publicUrl: (path: string) => string | null;
  /** The owner's preview of the draft (app/f/.../page.tsx canPreview). */
  preview?: boolean;
}): Promise<PreparedOffer> {
  const { doc, formId, tenantId } = input;
  let resolved: ResolvedLibrary = { videos: new Map(), images: new Map() };
  if (input.db) {
    try {
      resolved = await resolveDocLibrary(input.db, tenantId, doc);
    } catch (err) {
      // The page still draws: every Library video and image is left out.
      console.error("[offer-pages] Library media unavailable; drawn without it", {
        form_id: formId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const signed = await signPageMedia(resolved, input.sign);

  const media: MediaCheck = {
    video: (ref, video) => (video.source === "library" ? resolved.videos.has(ref) : embedUrl(video) !== null),
    image: (image) => signed.images.has(imageKey(image)),
  };
  const page = drawnPage(doc, { fallbackHeadline: input.fallbackHeadline, media });

  const out: PreparedOffer["media"] = {};
  const addVideo = (ref: string) => {
    const v =
      ref === "hero"
        ? doc.hero.video
        : (() => {
            const [key, idx] = ref.split(":");
            const s = doc.sections.find((x) => x.key === key);
            if (!s || !("items" in s)) return null;
            const item = (s.items as unknown[])[Number(idx)] as { video?: unknown } | undefined;
            return (item?.video as OfferPageDoc["hero"]["video"]) ?? null;
          })();
    if (!v) return;
    if (v.source === "library") {
      const r = resolved.videos.get(ref);
      if (!r) return;
      out[ref] = {
        source: { kind: "library", formId, videoRef: ref, captions: !!r.caption, ...(input.preview ? { preview: true as const } : {}) },
        posterUrl: signed.posters.get(ref) ?? null,
        posterWidth: r.poster?.width ?? null,
        posterHeight: r.poster?.height ?? null,
        aspect: v.aspect,
        duration: formatDuration(v.duration_s ?? r.asset.duration_s),
      };
      return;
    }
    const src = embedUrl(v);
    if (!src) return;
    const thumb = ownThumbPath(tenantId, v.thumb_path);
    let posterUrl: string | null = null;
    if (thumb) {
      try {
        posterUrl = input.publicUrl(thumb);
      } catch {
        posterUrl = null;
      }
    }
    out[ref] = {
      source: { kind: "link", embedSrc: src },
      posterUrl,
      posterWidth: null,
      posterHeight: null,
      aspect: v.aspect,
      duration: formatDuration(v.duration_s),
    };
  };
  if (page.hero.video) addVideo("hero");
  for (const s of page.sections) {
    if (s.key === "what_you_get") {
      for (const it of s.items) if (it.video) addVideo(it.video.ref);
    } else if (s.key === "work") {
      for (const it of s.items) addVideo(it.video.ref);
    } else if (s.key === "results") {
      for (const { item, index } of s.items) if (item.kind === "video") addVideo(`results:${index}`);
    }
  }

  const images: PreparedOffer["images"] = {};
  for (const [key, row] of resolved.images) {
    const url = signed.images.get(key);
    if (url) images[key] = { url, width: row.width, height: row.height };
  }

  return {
    page,
    accent: doc.theme.accent || DEFAULT_ACCENT,
    ctaLabel: doc.nav.cta_label || doc.hero.cta_label || DEFAULT_CTA[doc.template],
    media: out,
    images,
  };
}
