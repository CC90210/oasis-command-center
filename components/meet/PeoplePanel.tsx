"use client";

/**
 * components/meet/PeoplePanel.tsx - who is on the call. A host can remove someone, in two steps on the spot
 * (Remove, then "Remove from the meeting?" with Remove and Cancel): no confirm() dialog, which the app avoids.
 * It sits beside the faces on a wide screen and takes their place on a phone (components/meet/CallScreen.tsx).
 */

import { useEffect, useRef, useState } from "react";
import { MicOff, X } from "lucide-react";
import type { MeetTile } from "@/lib/meet/room-client";
import { FOCUS } from "./meet-classes";

export function PeoplePanel({
  tiles,
  isHost,
  onRemove,
  onClose,
}: {
  tiles: MeetTile[];
  isHost: boolean;
  onRemove: (participantId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<string | null>(null);

  const cancel = () => {
    restoreTo.current = confirming;
    setConfirming(null);
  };

  // Asking moves focus to the safe answer; cancelling puts it back on the Remove button it came from.
  useEffect(() => {
    if (confirming !== null) {
      cancelRef.current?.focus();
      return;
    }
    const id = restoreTo.current;
    restoreTo.current = null;
    if (id) listRef.current?.querySelector<HTMLElement>(`[data-remove="${CSS.escape(id)}"]`)?.focus();
  }, [confirming]);

  return (
    <section
      id="meet-people"
      aria-label="People"
      className="flex min-h-0 flex-1 flex-col border-t border-hairline bg-bg-deep lg:w-80 lg:flex-none lg:border-l lg:border-t-0"
      onKeyDown={(e) => {
        if (e.key === "Escape" && confirming !== null) {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold text-fg">People ({tiles.length})</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close people list"
          className={`grid h-11 w-11 place-items-center rounded-lg text-fg-muted hover:bg-active-hover hover:text-fg ${FOCUS}`}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ul ref={listRef} className="min-h-0 flex-1 divide-y divide-hairline overflow-y-auto px-3">
        {tiles.map((t) => {
          const canRemove = isHost && !t.me;
          const asking = confirming === t.participantId;
          return (
            <li key={t.participantId} className="py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 break-words text-sm text-fg">
                  {t.name}
                  {t.me ? " (You)" : ""}
                </span>
                {t.role === "host" ? (
                  <span className="rounded bg-active px-1.5 text-[10px] font-semibold leading-4 text-fg">Host</span>
                ) : null}
                {t.micOn ? null : (
                  <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                    <MicOff className="h-3.5 w-3.5 text-status-hot" aria-hidden />
                    Mic off
                  </span>
                )}
                {canRemove && !asking ? (
                  <button
                    type="button"
                    data-remove={t.participantId}
                    aria-label={`Remove ${t.name}`}
                    onClick={() => setConfirming(t.participantId)}
                    className={`min-h-11 rounded-lg border border-hairline px-3 text-xs font-medium text-fg hover:bg-active-hover ${FOCUS}`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {asking ? (
                <div
                  role="group"
                  aria-label={`Remove ${t.name}`}
                  className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-status-hot/40 bg-status-hot/10 p-2"
                >
                  <span className="text-sm text-fg">Remove from the meeting?</span>
                  <button
                    type="button"
                    aria-label={`Remove ${t.name} from the meeting`}
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(t.participantId);
                      try {
                        await onRemove(t.participantId);
                      } finally {
                        setBusy(null);
                        setConfirming(null);
                      }
                    }}
                    className={`min-h-11 rounded-lg border border-transparent bg-unread px-3 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`}
                  >
                    {busy === t.participantId ? "Removing..." : "Remove"}
                  </button>
                  <button
                    ref={cancelRef}
                    type="button"
                    disabled={busy !== null}
                    onClick={cancel}
                    className={`min-h-11 rounded-lg border border-hairline px-3 text-sm font-medium text-fg hover:bg-active-hover disabled:opacity-50 ${FOCUS}`}
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
