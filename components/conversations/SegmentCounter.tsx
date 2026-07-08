"use client";

/** SegmentCounter — live GSM-7 160/153 vs Unicode 70/67 SMS segment count,
 *  with an inline warning when emoji/curly-quotes/em-dash silently push the
 *  message into Unicode encoding (cutting the per-segment budget). */
import { AlertTriangle } from "lucide-react";
import { countSegments } from "./format";

export function SegmentCounter({ text }: { text: string }) {
  const info = countSegments(text);
  const warn = info.hasEmoji || info.hasSmartPunctuation;
  const over = info.remainingInSegment < 0;

  return (
    <div className="flex items-center gap-1.5 text-[10.5px] shrink-0">
      {warn && (
        <span
          title={
            info.hasEmoji
              ? "Emoji forces Unicode encoding — segment budget drops to 70/67 chars."
              : "Curly quotes or an em dash force Unicode encoding — segment budget drops to 70/67 chars."
          }
          className="text-status-warm inline-flex items-center"
        >
          <AlertTriangle className="h-3 w-3" />
        </span>
      )}
      <span className={over ? "text-status-hot font-semibold" : "text-fg-dim"}>
        {info.units}/{info.limitPerSegment * info.segments} · {info.segments} seg
        {info.segments === 1 ? "" : "s"} · {info.encoding}
      </span>
    </div>
  );
}
