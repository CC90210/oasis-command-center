/**
 * InternalNoteCard — full-width, no speech-bubble tail, amber tint. Used for
 * `channel === "note"` rows so an internal note is visually impossible to
 * confuse with a merchant-facing message (the whole point of the amber
 * treatment + persistent lock line).
 */
import { Lock } from "lucide-react";
import { relTime } from "./format";

export function InternalNoteCard({
  text,
  at,
  author,
}: {
  text: string;
  at: string;
  author?: string | null;
}) {
  return (
    <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-amber-300/90 font-semibold uppercase tracking-wide mb-1">
        <Lock className="h-3 w-3" />
        <span>Internal — not visible to merchant</span>
        <span className="ml-auto font-normal normal-case text-fg-dim">{relTime(at)}</span>
      </div>
      <div className="text-sm text-fg whitespace-pre-wrap break-words">{text}</div>
      {author && <div className="mt-1 text-[10.5px] text-fg-dim">{author}</div>}
    </div>
  );
}
