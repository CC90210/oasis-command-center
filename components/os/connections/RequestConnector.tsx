"use client";

/**
 * RequestConnector - "Ask OASIS for <app>" on a connector that is not built.
 *
 * One click files a ticket on OASIS's support desk through the existing
 * POST /api/tickets: a client workspace files it as its own portal ticket (the
 * client fields come from the session, so it can only ever be its own), and
 * OASIS's own workspace files an internal ticket on its own desk. Either way
 * the OASIS team sees it on /tickets. The button is the state, not a promise:
 * it says nothing about when the app will exist.
 */

import { useState } from "react";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";

export const CONNECTOR_REQUEST_ENDPOINT = "/api/tickets";

/** The ticket a request files: plain words a client may read on their own ticket. */
export function connectorRequestTicket(input: { name: string; reason?: string | null; from: string }) {
  return {
    title: `Connection request: ${input.name}`,
    description: [
      `Requested from ${input.from}: please make ${input.name} connectable for this workspace.`,
      input.reason ? `Why it is not available today: ${input.reason}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    category: "change_request" as const,
    severity: "low" as const,
  };
}

export function RequestConnector({
  name,
  reason,
  from,
  buttonClassName = "btn-primary w-full",
}: {
  name: string;
  reason?: string | null;
  from: string;
  /** The drawer's full-width button by default; a page row passes a smaller one. */
  buttonClassName?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);

  const request = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(CONNECTOR_REQUEST_ENDPOINT, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(connectorRequestTicket({ name, reason, from })),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; ticket?: { ticket_number?: string }; error?: string } | null;
      if (res.ok && data?.ok) {
        const number = data.ticket?.ticket_number ?? null;
        setSent(number ?? "sent");
        setNotice({
          tone: "ok",
          text: `Sent${number ? `: ticket ${number}` : ""}. The OASIS team sees it on its support desk and replies on the ticket.`,
        });
      } else if (res.status === 401 || res.status === 403) {
        setNotice({ tone: "err", text: "Your role cannot file requests here. Ask the workspace owner or an admin to send it." });
      } else {
        console.error("[connections.request]", res.status, data?.error);
        setNotice({ tone: "err", text: "The request was not sent. Try again in a minute." });
      }
    } catch (err) {
      console.error("[connections.request]", err);
      setNotice({ tone: "err", text: "Could not reach OASIS. The request was not sent." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Notice notice={notice} />
      <button type="button" onClick={request} disabled={busy || sent !== null} className={buttonClassName}>
        {sent ? `Asked for ${name}` : busy ? "Sending..." : `Ask OASIS for ${name}`}
      </button>
    </div>
  );
}
