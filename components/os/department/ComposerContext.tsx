"use client";

/**
 * ComposerContext — one draft shared by a department's channel and its
 * Overview panel, so "Suggested asks" (and a `?q=` handed over from Today's Ask
 * composer) land in the channel's message box without a page navigation.
 *
 * It only ever PREFILLS. Sending stays the person's own keystroke: an ask
 * clicked by accident must not become a turn, and nothing the URL carries may
 * speak for the viewer.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

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
  const value = useMemo(() => ({ draft, ask, channelReady }), [draft, ask, channelReady]);
  return <ComposerCtx.Provider value={value}>{children}</ComposerCtx.Provider>;
}

export function useComposer(): ComposerValue {
  const v = useContext(ComposerCtx);
  if (!v) throw new Error("useComposer must be used inside <ComposerProvider>");
  return v;
}
