"use client";

/**
 * ConnectorDrawerButton - one app's Connections drawer, opened in place from
 * another page (Settings > AI brain's Jev card). The SAME ConnectorDrawer the
 * Connections hub and the workspace setup render, with the status the server
 * computed through the same loader (connector-facts.ts loadConnectorStatuses),
 * so a key connected here reads the same everywhere. After a change the page
 * re-reads every status from the server (router.refresh), never guesses one.
 */

import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ConnectorDrawer } from "@/components/os/connections/ConnectorDrawer";
import { connectorBySlug, oauthStartHref, type ConnectorDef, type ConnectorStatus } from "@/lib/os/connectors";

export function ConnectorDrawerButton({
  slug,
  status,
  label,
  ariaLabel,
  className,
  requestFrom,
}: {
  slug: string;
  status: ConnectorStatus;
  /** The button's content: words, or a whole chip (Settings > Chat apps' not-built apps). */
  label: ReactNode;
  /** Needed when `label` is not plain words. */
  ariaLabel?: string;
  className?: string;
  /** Where a "not built yet" request was filed from. */
  requestFrom: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Stable: the sheet's focus and key handling re-run when these change.
  const close = useCallback(() => setOpen(false), []);
  // The drawer's footer button. An app signed in at the vendor's own page has
  // no popup watcher here, so it goes there in this window and comes back to
  // the Connections page with the result; every other app is set up in the
  // drawer itself.
  const reopen = useCallback((d: ConnectorDef) => {
    const action = d.live?.connect;
    if (action?.kind === "oauth") window.location.href = oauthStartHref(action.provider);
    else setOpen(true);
  }, []);
  const refresh = useCallback(() => router.refresh(), [router]);
  const def = connectorBySlug(slug);
  if (!def) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} aria-label={ariaLabel}>
        {label}
      </button>
      <ConnectorDrawer
        open={open}
        def={def}
        status={status}
        onClose={close}
        onConnect={reopen}
        onChanged={refresh}
        personalGoogle={false}
        requestFrom={requestFrom}
      />
    </>
  );
}
