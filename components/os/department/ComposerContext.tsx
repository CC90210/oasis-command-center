"use client";

/**
 * ComposerContext — one draft shared by a department's channel and its
 * Overview panel, so "Suggested asks" (and a `?q=` handed over from Today's Ask
 * composer) land in the channel's message box without a page navigation.
 *
 * `?ask=` (lib/os/chat-href.ts askDepartment) is how every other page hands a
 * prompt to a department: a business document's "Ask Finance", a prompts
 * library card, a drill. It is read ONCE, on mount, from the address bar:
 * the text becomes the draft (when the channel can answer), and the URL is
 * replaced without it, so a reload or a copied link does not prefill again.
 *
 * It only ever PREFILLS. Sending stays the person's own keystroke: an ask
 * clicked by accident must not become a turn, and nothing the URL carries may
 * speak for the viewer.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyAskParam } from "@/lib/os/chat-href";

/** `nonce` changes on every ask, so asking the same thing twice still refills. */
export type ComposerDraft = { text: string; nonce: number };

type ComposerValue = {
  draft: ComposerDraft | null;
  ask: (text: string) => void;
  /** False when the channel cannot answer; asks are then not offered. */
  channelReady: boolean;
};

const ComposerCtx = createContext<ComposerValue | null>(null);

export function ComposerProvider({
  initialText,
  channelReady,
  children,
}: {
  initialText: string | null;
  channelReady: boolean;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<ComposerDraft | null>(
    initialText ? { text: initialText, nonce: 1 } : null,
  );
  const ask = useCallback((text: string) => {
    setDraft((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // `?ask=`: read once, prefill, clean the URL. The URL is replaced with the
  // History API, which Next's App Router observes (usePathname and
  // useSearchParams follow it) without refetching the page; useRouter would
  // also tie this provider to a mounted router, which a server render of the
  // tab (tests/os-channels-honest) does not have. The ref keeps a re-render
  // from reading the parameter a second time. applyAskParam
  // (lib/os/chat-href.ts) is the whole read; this effect adds nothing to it,
  // and tests/playbook-docs.test.ts pins both halves.
  const askRead = useRef(false);
  useEffect(() => {
    if (askRead.current) return;
    askRead.current = true;
    applyAskParam(window, channelReady, ask);
  }, [ask, channelReady]);

  const value = useMemo(() => ({ draft, ask, channelReady }), [draft, ask, channelReady]);
  return <ComposerCtx.Provider value={value}>{children}</ComposerCtx.Provider>;
}

export function useComposer(): ComposerValue {
  const v = useContext(ComposerCtx);
  if (!v) throw new Error("useComposer must be used inside <ComposerProvider>");
  return v;
}
