"use client";

/**
 * SuggestedAsks — one-click starting points for the department's channel.
 * A click fills the channel's message box (ComposerContext); the person still
 * presses Send. Not rendered when the channel cannot answer: an ask that opens
 * a dead composer is a button that does nothing.
 */

import { useComposer } from "./ComposerContext";
import type { SuggestedAsk } from "./config";

export function SuggestedAsks({ asks }: { asks: readonly SuggestedAsk[] }) {
  const { ask, channelReady } = useComposer();
  if (!channelReady) {
    return <p className="text-[13px] leading-5 text-fg-dim">Available once the channel is connected.</p>;
  }
  return (
    <ul className="space-y-1">
      {asks.map((a) => (
        <li key={a.title}>
          <button
            type="button"
            onClick={() => ask(a.prompt)}
            title={a.prompt}
            className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 text-fg-muted transition-colors duration-150 hover:bg-active-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/60"
          >
            {a.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
