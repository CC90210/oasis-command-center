"use client";

/**
 * LiveStatusPill - the department header pill, kept true while the page is open.
 *
 * It starts on the server's answer (`initial`, StatusPill.tsx headerStatus) and
 * redraws when this department's channel finishes a turn (turn-event.ts), from
 * the counts' status and that turn (headerAfterTurn). So a reply that arrives
 * clears an old "Not working", and a turn that fails says why, without a reload.
 */

import { useEffect, useState } from "react";
import { StatusPill, headerAfterTurn, type DepartmentStatus } from "./StatusPill";
import { CHANNEL_TURN_EVENT, turnFromEvent } from "./turn-event";

export function LiveStatusPill({
  department,
  status,
  channelReady,
  initial,
}: {
  department: string;
  /** The counts' status (statusFor), before any turn is applied. */
  status: DepartmentStatus;
  channelReady: boolean;
  /** The header the server drew. */
  initial: DepartmentStatus;
}) {
  const [header, setHeader] = useState<DepartmentStatus>(initial);
  useEffect(() => {
    setHeader(initial);
    const onTurn = (ev: Event) => {
      const turn = turnFromEvent(ev);
      if (turn && turn.department === department) setHeader(headerAfterTurn(status, channelReady, turn));
    };
    window.addEventListener(CHANNEL_TURN_EVENT, onTurn);
    return () => window.removeEventListener(CHANNEL_TURN_EVENT, onTurn);
  }, [department, status, channelReady, initial]);
  return <StatusPill status={header} />;
}
