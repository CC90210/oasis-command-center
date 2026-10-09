"use client";

/**
 * VideoPicker - attach a video to the hero or to an item (design 2.2 step 4).
 *
 *   Paste a link       YouTube, Vimeo or Loom, checked on the server (the id
 *                      is parsed; anything else is refused) and previewed with
 *                      our own copy of its thumbnail.
 *   Choose from Library  OASIS's own workspace only (MKT-12): approved or
 *                      published videos of OASIS's own brand, with poster,
 *                      length and a captions badge.
 *
 * Nothing attaches without the tick "I have the right to show this video
 * publicly"; the server records who ticked it and when.
 */
import { useState } from "react";
import { Film, Link2, Loader2, X } from "lucide-react";
import type { Aspect, VideoRef } from "@/lib/offer-pages/types";
import { ASPECTS } from "@/lib/offer-pages/types";
import { formatDuration } from "@/lib/offer-pages/providers";
import { SmallButton, Tick, pendingConfirmation } from "./fields";

type LibraryVideo = {
  asset_id: string;
  title: string;
  aspect: string | null;
  duration_s: number | null;
  video_media_id: string;
  poster_media_id: string | null;
  caption_media_id: string | null;
  poster_url: string | null;
};

type Candidate = { ref: Omit<VideoRef, "rights">; label: string; thumb: string | null };

function describe(v: VideoRef): string {
  if (v.source === "library") return "Library video";
  const name = v.source === "youtube" ? "YouTube" : v.source === "vimeo" ? "Vimeo" : "Loom";
  return v.title ? `${name}: ${v.title}` : `${name} video ${v.id}`;
}

export function VideoPicker({
  formId,
  value,
  onChange,
  libraryAvailable,
  label = "Video",
}: {
  formId: string;
  value: VideoRef | null | undefined;
  onChange: (v: VideoRef | null) => void;
  libraryAvailable: boolean;
  label?: string;
}) {
  const [mode, setMode] = useState<"idle" | "link" | "library">("idle");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [rights, setRights] = useState(false);
  const [library, setLibrary] = useState<LibraryVideo[] | null>(null);

  async function checkLink() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/forms/${formId}/offer/video-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        video?: Omit<VideoRef, "rights">;
        preview_url?: string | null;
      };
      if (!data.ok || !data.video) {
        setError(data.message || "That link couldn't be checked. Paste a YouTube, Vimeo or Loom link to one video.");
        return;
      }
      setCandidate({ ref: data.video, label: describe({ ...data.video, rights: pendingConfirmation() } as VideoRef), thumb: data.preview_url ?? null });
    } catch {
      setError("That link couldn't be checked. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function openLibrary() {
    setMode("library");
    if (library) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/forms/${formId}/offer/library-videos`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; available?: boolean; videos?: LibraryVideo[] };
      if (!data.ok) {
        setError("The Library couldn't be read. Try again in a minute.");
        return;
      }
      setLibrary(data.videos ?? []);
    } catch {
      setError("The Library couldn't be read. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  function pickLibrary(v: LibraryVideo) {
    const aspect = (ASPECTS as readonly string[]).includes(v.aspect ?? "") ? (v.aspect as Aspect) : "16:9";
    setCandidate({
      ref: {
        source: "library",
        asset_id: v.asset_id,
        video_media_id: v.video_media_id,
        ...(v.poster_media_id ? { poster_media_id: v.poster_media_id } : {}),
        ...(v.caption_media_id ? { caption_media_id: v.caption_media_id } : {}),
        aspect,
        ...(v.duration_s ? { duration_s: Math.round(v.duration_s) } : {}),
      } as Omit<VideoRef, "rights">,
      label: v.title || "Library video",
      thumb: v.poster_url,
    });
  }

  function attach() {
    if (!candidate || !rights) return;
    onChange({ ...candidate.ref, rights: pendingConfirmation() } as VideoRef);
    setCandidate(null);
    setRights(false);
    setMode("idle");
    setUrl("");
  }

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-bg-border bg-bg-deep/40 px-3 py-2">
        <Film className="h-4 w-4 text-accent" />
        <span className="text-[13px] text-fg">{describe(value)}</span>
        <select
          className="select !py-1 text-xs"
          value={value.aspect}
          onChange={(e) => onChange({ ...value, aspect: e.target.value as Aspect })}
          aria-label="Shape"
        >
          {ASPECTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        {value.duration_s ? <span className="font-mono text-[11px] text-fg-dim">{formatDuration(value.duration_s)}</span> : null}
        {value.source === "library" && !value.caption_media_id ? <span className="text-[11px] text-status-warm">No captions</span> : null}
        <span className="ml-auto">
          <SmallButton tone="danger" onClick={() => onChange(null)}>
            Remove
          </SmallButton>
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-bg-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-semibold text-fg">{label}</span>
        <SmallButton tone="primary" onClick={() => setMode("link")}>
          <span className="inline-flex items-center gap-1">
            <Link2 className="h-3 w-3" />
            Paste a link
          </span>
        </SmallButton>
        {libraryAvailable ? (
          <SmallButton tone="primary" onClick={openLibrary}>
            <span className="inline-flex items-center gap-1">
              <Film className="h-3 w-3" />
              Choose from Library
            </span>
          </SmallButton>
        ) : null}
        {mode !== "idle" ? (
          <span className="ml-auto">
            <SmallButton onClick={() => { setMode("idle"); setCandidate(null); setError(null); }}>
              <X className="h-3 w-3" />
            </SmallButton>
          </span>
        ) : null}
      </div>

      {mode === "link" && !candidate ? (
        <div className="flex gap-2">
          <input
            className="input flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
          />
          <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={checkLink} disabled={busy || !url.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Check"}
          </button>
        </div>
      ) : null}

      {mode === "library" && !candidate ? (
        busy ? (
          <div className="text-xs text-fg-muted">Loading the Library...</div>
        ) : library && library.length === 0 ? (
          <div className="text-xs text-fg-muted">No approved or published OASIS videos in the Library yet.</div>
        ) : (
          <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {(library ?? []).map((v) => (
              <button
                type="button"
                key={v.asset_id}
                onClick={() => pickLibrary(v)}
                className="overflow-hidden rounded-lg border border-bg-border text-left hover:border-accent"
              >
                <div className="aspect-video bg-bg-deep">
                  {v.poster_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed Library poster
                    <img src={v.poster_url} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="space-y-0.5 p-2">
                  <div className="truncate text-[12px] text-fg">{v.title || "Untitled"}</div>
                  <div className="flex gap-2 text-[10px] text-fg-dim">
                    {v.duration_s ? <span>{formatDuration(v.duration_s)}</span> : null}
                    <span>{v.caption_media_id ? "Captions" : "No captions"}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : null}

      {candidate ? (
        <div className="space-y-3 rounded-lg bg-bg-elev/40 p-3">
          <div className="flex items-center gap-3">
            {candidate.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element -- preview of the stored thumbnail
              <img src={candidate.thumb} alt="" className="h-14 w-24 rounded object-cover" />
            ) : (
              <div className="grid h-14 w-24 place-items-center rounded bg-bg-deep text-fg-dim">
                <Film className="h-4 w-4" />
              </div>
            )}
            <span className="text-[13px] text-fg">{candidate.label}</span>
          </div>
          <Tick checked={rights} onChange={setRights}>
            I have the right to show this video publicly.
          </Tick>
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={attach} disabled={!rights}>
            Attach
          </button>
        </div>
      ) : null}

      {error ? <div className="text-xs text-rose-400">{error}</div> : null}
    </div>
  );
}
