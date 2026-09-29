"use client";

/**
 * The Ask composer at the top of Today: "What should the team work on today?"
 *
 * It hands the text to the Chief of Staff department (plan D2) as the
 * `?q=` prefill parameter (ASK_PREFILL_PARAM in ask.ts) and opens it. It sends nothing itself:
 * until channels exist (plan W4) there is no agent turn to start from here, and
 * a composer that looked like it had sent a message would be lying.
 *
 * Enter asks, Shift+Enter adds a line. Warm-on-intent prefetch when the field
 * gets focus, matching the rail (prefetch stays off on the link itself).
 */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft } from "lucide-react";
import { useWarmOnIntent } from "@/components/os/RailRow";
import { ASK_MAX_CHARS, askPrefillHref } from "@/components/os/today/ask";

export function AskComposer({ href }: { href: string }) {
  const router = useRouter();
  const warm = useWarmOnIntent(href);
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;

  function ask(e?: FormEvent) {
    e?.preventDefault();
    if (!ready) return;
    router.push(askPrefillHref(href, text));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing: Enter that confirms an IME candidate is not a submit.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
    }
  }

  return (
    <form
      onSubmit={ask}
      className="rounded-xl border border-hairline bg-bg-panel transition-colors duration-150 focus-within:border-accent/60"
    >
      <label htmlFor="today-ask" className="sr-only">
        Ask your Chief of Staff
      </label>
      <textarea
        id="today-ask"
        name="ask"
        rows={2}
        maxLength={ASK_MAX_CHARS}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={warm}
        placeholder="What should the team work on today?"
        className="block w-full resize-none bg-transparent px-4 pt-3 text-sm leading-[22px] text-fg outline-none placeholder:text-fg-dim"
      />
      <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-1">
        <span className="pl-1 text-xs text-fg-dim">Opens your Chief of Staff with this as the brief</span>
        <button type="submit" disabled={!ready} className="btn-primary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-[13px]">
          Ask
          <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </form>
  );
}
