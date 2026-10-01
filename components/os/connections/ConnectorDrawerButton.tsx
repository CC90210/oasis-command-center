"use client";

/**
 * ConnectorDrawerButton - one app's Connections drawer, opened in place from
 * another page (Settings > AI brain's Jev card). The SAME ConnectorDrawer the
 * Connections hub and the workspace setup render, with the status the server
 * computed through the same loader (connector-facts.ts loadConnectorStatuses),
 * so a key connected here reads the same everywhere. After a change the page
 * re-reads every status from the server (router.refresh), never guesses one.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ConnectorDrawer } from "@/components/os/connections/ConnectorDrawer";
import { connectorBySlug, type ConnectorStatus } from "@/lib/os/connectors";

export function ConnectorDrawerButton({
  slug,
  status,
  label,
  className,
  requestFrom,
}: {
  slug: string;
  status: ConnectorStatus;
  label: string;
  className?: string;
  /** Where a "not built yet" request was filed from. */
  requestFrom: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Stable: the sheet's focus and key handling re-run when these change.
  const close = useCallback(() => setOpen(false), []);
  const reopen = useCallback(() => setOpen(true), []);
  const refresh = useCallback(() => router.refresh(), [router]);
  const def = connectorBySlug(slug);
  if (!def) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
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
