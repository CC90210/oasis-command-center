"use client";

/**
 * VideoFacade - a poster and a play button until the visitor taps; then, and
 * only then, the video (design section 4).
 *
 * NOTHING VIDEO-RELATED LOADS BEFORE THE TAP. The server HTML holds the poster
 * <img> and a <button>: no <video src>, no <iframe>, no player script. On tap:
 *   - a YouTube / Vimeo / Loom video becomes the provider's iframe, built on
 *     the server from a validated id (lib/offer-pages/providers.ts embedUrl);
 *   - a Library video asks /api/offer-page/video for a signed URL (the server
 *     re-checks that the video is in the PUBLISHED page of a live offer on an
 *     enabled form) and plays it in a native <video>. If the URL expires
 *     mid-watch, it asks again and resumes where the visitor was.
 *   - in the owner's signed-in preview of the DRAFT (source.preview), the same
 *     video and its captions come from the builder's own route,
 *     /api/forms/<id>/offer/preview-video, which reads the draft and answers
 *     only an owner or admin of the form's workspace.
 * No player library: a facade, a fetch and the browser's own player.
 */
import { useEffect, useRef, useState } from "react";
import type { Aspect } from "@/lib/offer-pages/types";
import { ACCENT_FILL } from "./styles";

export type FacadeSource =
  | { kind: "link"; embedSrc: string }
  | { kind: "library"; formId: string; videoRef: string; captions: boolean; preview?: true };

/** Where a Library video is signed, and its captions read: the draft for the owner's preview, else the live page. */
export function libraryEndpoints(s: Extract<FacadeSource, { kind: "library" }>): { sign: string; body: string; captions: string } {
  const ref = encodeURIComponent(s.videoRef);
  if (s.preview) {
    const base = `/api/forms/${encodeURIComponent(s.formId)}/offer/preview-video`;
    return { sign: base, body: JSON.stringify({ ref: s.videoRef }), captions: `${base}?ref=${ref}` };
  }
  return {
    sign: "/api/offer-page/video",
    body: JSON.stringify({ form_id: s.formId, ref: s.videoRef }),
    captions: `/api/offer-page/captions?form_id=${encodeURIComponent(s.formId)}&ref=${ref}`,
  };
}

const ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";

/** Poster dimensions when the media row does not carry them. */
const ASPECT_SIZE: Record<Aspect, [number, number]> = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};

function frameStyle(aspect: Aspect): React.CSSProperties {
  switch (aspect) {
    case "9:16":
      return { aspectRatio: "9 / 16", height: "min(70vh, 640px)", maxWidth: "100%" };
    case "1:1":
      return { aspectRatio: "1 / 1", width: "100%", maxWidth: "min(70vh, 560px)" };
    case "4:5":
      return { aspectRatio: "4 / 5", width: "100%", maxWidth: "min(56vh, 512px)" };
    default:
      return { aspectRatio: "16 / 9", width: "100%" };
  }
}

export function VideoFacade({
  source,
  posterUrl,
  posterWidth,
  posterHeight,
  aspect,
  label,
  duration,
  priority = false,
}: {
  source: FacadeSource;
  posterUrl: string | null;
  posterWidth?: number | null;
  posterHeight?: number | null;
  aspect: Aspect;
  /** Accessible name: "Play video: <label>". */
  label: string;
  /** "4:12", or "" when unknown. */
  duration?: string;
  /** The hero's poster: fetched first, never lazy. */
  priority?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const [src, setSrc] = useState<string | null>(null);
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const resumeAt = useRef(0);
  const resigns = useRef(0);
  const [defW, defH] = ASPECT_SIZE[aspect] ?? ASPECT_SIZE["16:9"];

  async function signedUrl(): Promise<string | null> {
    if (source.kind !== "library") return null;
    const at = libraryEndpoints(source);
    try {
      const res = await fetch(at.sign, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: at.body,
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string } | null;
      return res.ok && data?.ok && typeof data.url === "string" ? data.url : null;
    } catch {
      return null;
    }
  }

  async function start() {
    if (state === "loading" || state === "playing") return;
    if (source.kind === "link") {
      setState("playing");
      return;
    }
    setState("loading");
    const url = await signedUrl();
    if (!url) {
      setState("failed");
      return;
    }
    setSrc(url);
    setState("playing");
  }

  // The tap was the visitor asking it to play; some browsers still want play()
  // called from script once the element exists.
  useEffect(() => {
    if (state !== "playing" || source.kind !== "library" || !src) return;
    const el = videoEl.current;
    if (el && typeof el.play === "function") void el.play().catch(() => undefined);
  }, [state, src, source.kind]);

  /** A signed URL that expired mid-watch: ask again, then resume where they were. */
  async function onMediaError() {
    if (source.kind !== "library" || resigns.current >= 3) {
      setState("failed");
      return;
    }
    resigns.current += 1;
    resumeAt.current = videoEl.current?.currentTime ?? 0;
    const url = await signedUrl();
    if (!url) {
      setState("failed");
      return;
    }
    setSrc(url);
  }

  function onLoaded() {
    const el = videoEl.current;
    if (!el || resumeAt.current <= 0) return;
    el.currentTime = resumeAt.current;
    resumeAt.current = 0;
    void el.play?.().catch(() => undefined);
  }

  const frame = frameStyle(aspect);
  const playing = state === "playing";

  return (
    <div className="relative mx-auto overflow-hidden rounded-xl border border-ops-line bg-ops-panel shadow-raised" style={frame}>
      {playing && source.kind === "link" ? (
        <iframe
          src={source.embedSrc}
          title={label}
          allow={ALLOW}
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      ) : playing && source.kind === "library" && src ? (
        <video
          ref={videoEl}
          src={src}
          controls
          autoPlay
          playsInline
          preload="auto"
          onError={onMediaError}
          onLoadedMetadata={onLoaded}
          className="absolute inset-0 h-full w-full bg-black object-contain"
        >
          {source.captions ? (
            <track
              kind="captions"
              src={libraryEndpoints(source).captions}
              srcLang="en"
              label="English"
              default
            />
          ) : null}
        </video>
      ) : (
        <button
          type="button"
          onClick={start}
          aria-label={`Play video: ${label}`}
          className="group absolute inset-0 block h-full w-full cursor-pointer text-left"
        >
          {posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed, private-bucket poster: next/image would proxy it
            <img
              src={posterUrl}
              alt=""
              width={posterWidth || defW}
              height={posterHeight || defH}
              loading={priority ? "eager" : "lazy"}
              decoding="async"
              {...(priority ? { fetchPriority: "high" as const } : {})}
              className="absolute inset-0 h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
            />
          ) : null}
          <span className="absolute inset-0 bg-gradient-to-t from-ops-void/70 via-transparent to-transparent" aria-hidden="true" />
          <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
            <span
              className={`grid h-16 w-16 place-items-center rounded-full ${ACCENT_FILL} text-ops-void shadow-raised transition-transform duration-200 group-hover:scale-105 sm:h-[72px] sm:w-[72px]`}
            >
              {state === "loading" ? (
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-ops-void/30 border-t-ops-void" />
              ) : (
                <svg viewBox="0 0 24 24" className="ml-1 h-7 w-7" fill="currentColor" aria-hidden="true">
                  <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z" />
                </svg>
              )}
            </span>
          </span>
          {duration ? (
            <span className="absolute bottom-3 right-3 rounded bg-ops-void/75 px-2 py-1 font-data text-[11px] tracking-[0.08em] text-fg">
              {duration}
            </span>
          ) : null}
          {state === "failed" ? (
            <span className="absolute inset-x-3 bottom-3 rounded bg-ops-void/85 px-3 py-2 text-[13px] text-fg-muted">
              This video can&apos;t play right now. Try again in a moment.
            </span>
          ) : null}
        </button>
      )}
    </div>
  );
}
