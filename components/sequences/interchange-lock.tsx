"use client";

/**
 * A page-wide lock on template interchange, held from the moment a swap saves
 * until the refreshed server data actually arrives.
 *
 * WHY IT HAS TO BE SHARED. Every TemplateInterchange on the page builds its
 * PATCH from the same server-rendered `steps` array and sends the WHOLE array.
 * So a swap on step 2 while step 1's swap is still in flight — or merely not yet
 * reflected in props — rewrites step 1 back to the copy the page loaded with.
 * The operator sees "swapped" twice and only one survives, and the audit records
 * the revert as something they chose to do.
 *
 * `router.refresh()` alone does not close this: it returns immediately, the
 * button re-enables, and the components keep the stale snapshot until new props
 * land. A per-component guard cannot close it either, because the component
 * being reverted is not the one that saved. The lock lives above all of them.
 *
 * It clears on the identity of the `rows` prop, which is a NEW object each time
 * the server component re-renders. That is the actual signal "fresh data is
 * here" — not a timer, and not an assumption about how long a refresh takes.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type LockValue = {
  /** A save has landed and fresh props have not arrived yet. */
  locked: boolean;
  markSaved: () => void;
};

// Default is UNLOCKED so a TemplateInterchange rendered outside a provider
// still works. It degrades to the old behaviour rather than becoming inert,
// which is the right failure for a UI affordance.
const Ctx = createContext<LockValue>({ locked: false, markSaved: () => {} });

export function useInterchangeLock(): LockValue {
  return useContext(Ctx);
}

export function InterchangeLockProvider({ resetKey, children }: { resetKey: unknown; children: ReactNode }) {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    // New server data. Whatever was saved is now reflected in props, so the
    // snapshot every child holds is current again.
    setLocked(false);
  }, [resetKey]);

  return <Ctx.Provider value={{ locked, markSaved: () => setLocked(true) }}>{children}</Ctx.Provider>;
}
