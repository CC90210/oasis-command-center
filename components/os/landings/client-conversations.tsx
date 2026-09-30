"use client";

/**
 * ClientConversations — the record's Conversations tab: the client's email,
 * SMS and Slack in ONE thread (rendered with the inbox's own MessageList), the
 * agents' drafts waiting for approval, and a composer.
 *
 * THE COMPOSER ASKS FIRST. "Review and send" shows exactly where the email
 * goes and from which mailbox; only "Send now" posts, with confirmed: true
 * (POST /api/clients/[id]/reply). The route's own sentence is shown on any
 * refusal (no mailbox, opted out, dry run) and the draft stays in the box.
 * After a send the page re-reads, so the message appears in the thread from
 * the ledger, not from local state.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageList } from "@/components/conversations/MessageList";
import type { ConversationMessage } from "@/lib/conversation-threading";
import type { ClientDraft } from "@/lib/os/customers/conversations";

type Recipient = { email: string; label: string };

export function ClientConversations({
  customerId,
  clientName,
  messages,
  drafts,
  truncated,
  recipients,
  mailboxNote,
  canSend,
}: {
  customerId: string;
  clientName: string;
  messages: ConversationMessage[];
  drafts: ClientDraft[];
  truncated: boolean;
  recipients: Recipient[];
  /** Which mailbox sends, in words (OASIS's, or the teammate's own). */
  mailboxNote: string;
  canSend: boolean;
}) {
  const pending = drafts.filter((d) => d.status === "pending");
  const decided = drafts.filter((d) => d.status !== "pending");
  // The inbox's MessageList labels days and times in the BROWSER's zone and
  // locale (components/conversations/format.ts), which the server cannot know:
  // rendered on the server it would not match the browser's first render
  // (React #418). So the thread renders once the page is in the browser.
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <section className="flex flex-col rounded-xl border border-hairline bg-bg-panel lg:col-span-2" aria-label={`Conversation with ${clientName}`}>
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
          <h2 className="text-sm font-semibold text-fg">Conversation</h2>
          <span className="text-xs text-fg-dim">Email, SMS and Slack, oldest first</span>
        </div>
        {truncated && <p className="px-4 pt-2 text-xs text-fg-dim">Only the latest 300 messages per channel are shown.</p>}
        <div className="flex max-h-[560px] min-h-[240px] flex-col">
          {messages.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-fg-muted">
              No messages with this client yet. Email to or from their addresses, texts to their numbers, messages on the deal
              they came from and Slack in a channel mapped to them appear here.
            </p>
          ) : inBrowser ? (
            <MessageList messages={messages} />
          ) : (
            <p className="px-4 py-8 text-center text-[13px] text-fg-dim">
              Loading {messages.length} message{messages.length === 1 ? "" : "s"}...
            </p>
          )}
        </div>
        {canSend ? (
          <Composer customerId={customerId} recipients={recipients} mailboxNote={mailboxNote} />
        ) : (
          <p className="border-t border-hairline px-4 py-3 text-[13px] text-fg-muted">
            Writing to clients is for the workspace&rsquo;s owners and admins.
          </p>
        )}
      </section>
      <aside className="space-y-4">
        <div className="rounded-xl border border-hairline bg-bg-panel p-4">
          <h3 className="text-sm font-semibold text-fg">Drafts from your AI team</h3>
          <p className="mt-0.5 text-[13px] text-fg-muted">An agent never emails a client by itself: its drafts wait here and in Feed until someone approves them.</p>
          {pending.length === 0 ? (
            <p className="mt-3 text-[13px] text-fg-dim">None waiting.</p>
          ) : (
            <ul className="mt-3 divide-y divide-hairline">
              {pending.map((d) => (
                <li key={d.id} className="py-2">
                  <div className="text-sm text-fg">{d.subject ?? d.title}</div>
                  <div className="text-xs text-fg-dim">To {d.to ?? "an address"} · waiting for approval</div>
                </li>
              ))}
            </ul>
          )}
          {pending.length > 0 && (
            <Link href="/feed" prefetch={false} className="mt-2 inline-block text-[13px] text-accent hover:underline">
              Review in Feed
            </Link>
          )}
          {decided.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-hairline pt-3">
              {decided.slice(0, 5).map((d) => (
                <li key={d.id} className="text-xs text-fg-dim">
                  {d.subject ?? d.title}: {d.outcome ?? d.status.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function Composer({ customerId, recipients, mailboxNote }: { customerId: string; recipients: Recipient[]; mailboxNote: string }) {
  const router = useRouter();
  const [to, setTo] = useState(recipients[0]?.email ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (recipients.length === 0) {
    return (
      <p className="border-t border-hairline px-4 py-3 text-[13px] text-fg-muted">
        This client has no email address. Add one with Edit details on the Overview tab, then write to them here.
      </p>
    );
  }

  const ready = Boolean(to && subject.trim() && body.trim());
  const send = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(customerId)}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "email", to, subject, body, confirmed: true }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data || data.ok !== true) {
        setError((data && typeof data.message === "string" && data.message) || `The request failed (HTTP ${res.status}). Nothing was sent.`);
        return;
      }
      const message = typeof data.message === "string" ? data.message : null;
      if (data.status === "sent") {
        setSubject("");
        setBody("");
        setNotice(message ?? "Sent.");
        router.refresh();
      } else if (data.status === "delivery_unknown") {
        setNotice(message);
        router.refresh();
      } else {
        // dry_run: nothing left the building; the draft stays.
        setNotice(message);
      }
    } catch {
      setError("Network error. It is not known whether the email went: check the conversation before sending again.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <form
      className="space-y-3 border-t border-hairline p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) setConfirming(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">To</span>
          <select className="select" value={to} disabled={busy || confirming} onChange={(e) => setTo(e.target.value)}>
            {recipients.map((r) => (
              <option key={r.email} value={r.email}>{`${r.label}: ${r.email}`}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Subject</span>
          <input className="input" maxLength={200} value={subject} disabled={busy || confirming} onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      <label className="block">
        <span className="label">Message</span>
        <textarea
          className="input min-h-[120px]"
          maxLength={20000}
          value={body}
          disabled={busy || confirming}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <p className="text-xs text-fg-dim">{mailboxNote}</p>
      {confirming ? (
        <div role="alertdialog" aria-label="Confirm send" className="rounded-xl border border-hairline bg-bg-panel p-3">
          <p className="text-sm text-fg">
            Send this email to <span className="font-medium">{to}</span> now?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void send()}>
              {busy ? "Sending..." : "Send now"}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Back to editing
            </button>
          </div>
        </div>
      ) : (
        <button type="submit" className="btn-primary" disabled={busy || !ready}>
          Review and send
        </button>
      )}
      {error && (
        <p className="text-sm text-status-hot" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-fg-muted" role="status">
          {notice}
        </p>
      )}
    </form>
  );
}
