"use client";

/**
 * The presentation brief: the one card CC reads before and during the call
 * (CC, 2026-11-01: "done for you", one place instead of eight tabs). It shows
 * only what is already prepared, and links to where each part is edited:
 *
 *   - the client: business, contact, and the website, labelled Verified only
 *     when the pre-call brief actually read it (lib/ai-audit/briefs.ts);
 *   - what the checks found: the brief's likely problems (Hypotheses, each with
 *     how to test it on the call) and what the site shows (Verified);
 *   - what to offer: the drafted audit's opportunities once research has run
 *     after Gate 1, and until then that they are drafted from the call;
 *   - the call: join the Oasis Meet room booked with the meeting, and the
 *     live-call screen for notes.
 *
 * Read-only, internal, nothing here reaches the client. Nothing is made up: a
 * part that is not prepared yet says so.
 */
import Link from "next/link";
import type { EngagementView } from "@/lib/ai-audit/view";
import { diagnosticSignals, meetingTime, presentationOptions } from "@/lib/ai-audit/presentation";

/** How many of each list the card shows; the rest are on the "Call and transcripts" tab. */
const SHOW = 4;

/**
 * The room to join: the room booked with this engagement's meeting while it is open; otherwise, of the
 * lead's rooms not ended, the one that starts first (CodeRabbit on #789: a room left from an earlier
 * booking must not stand in for the one linked here). Null when none is open.
 */
export function roomToJoin(rooms: EngagementView["meetRooms"], linkedRoomId: string | null): EngagementView["meetRooms"][number] | null {
  const live = rooms.filter((r) => !r.endedAt && r.status !== "ended");
  const linked = linkedRoomId ? live.find((r) => r.id === linkedRoomId) : undefined;
  if (linked) return linked;
  if (!live.length) return null;
  return [...live].sort((a, b) => (a.startsAt ?? a.createdAt).localeCompare(b.startsAt ?? b.createdAt))[0];
}

export function PresentationBrief({ view, onOpenResearch }: { view: EngagementView; onOpenResearch: () => void }) {
  const e = view.engagement;
  const b = view.brief?.content ?? null;
  const readSite = b?.site.kind === "site" && b.site.pages_read > 0 ? b.site.url : null;
  const statedSite = view.lead?.website ?? null;
  const signals = diagnosticSignals(b);
  const options = presentationOptions(b, e.business_type, view.catalogue);
  const opportunities = view.audit?.doc?.sections.opportunities.items ?? [];
  const room = roomToJoin(view.meetRooms, e.meet_room_id);

  return (
    <section aria-label="Presentation brief" className="grid gap-4 rounded-xl border border-accent/40 bg-bg-panel p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">Presentation brief</h2>
          {room?.startsAt ? <div className="text-[13px] tabular-nums text-fg">Call: {meetingTime(room.startsAt)}</div> : null}
          <div className="text-[12px] text-fg-muted">Everything prepared for this call, in one place. Nothing here is shown to the client.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {room ? (
            <a href={room.path} target="_blank" rel="noopener noreferrer" className="btn-primary">
              Join the call room
            </a>
          ) : null}
          <Link href={`/ai-audits/${e.id}/call`} className={room ? "btn-secondary" : "btn-primary"}>
            Live-call notes
          </Link>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid content-start gap-1">
          <h3 className="text-[13px] font-semibold text-fg">The client</h3>
          <div className="text-fg">{e.business_name || "Unnamed business"}</div>
          <div className="text-fg-muted">{[e.contact_name, e.contact_email].filter(Boolean).join(", ") || "No contact saved"}</div>
          <div className="min-w-0 break-all text-fg-muted">
            {readSite ? (
              <>
                <span className="mr-1 rounded border border-hairline px-1.5 py-px text-[11px]">Verified</span>
                <a href={readSite} target="_blank" rel="noopener noreferrer" className="text-fg underline underline-offset-2">
                  {readSite}
                </a>
              </>
            ) : statedSite ? (
              <>Website given: {statedSite} (not read{b ? ": see what could not be checked" : " yet"})</>
            ) : (
              "No website given"
            )}
          </div>
          {!room ? <div className="text-[12px] text-fg-muted">No Oasis Meet room is booked with this call yet.</div> : null}
        </div>

        <div className="grid content-start gap-1">
          <h3 className="text-[13px] font-semibold text-fg">Key diagnostic signals</h3>
          {!b ? (
            <div className="text-fg-muted">The website check runs by itself once the call is booked. Nothing is built yet.</div>
          ) : signals.length ? (
            <ul className="grid gap-1.5">
              {signals.map((signal) => (
                <li key={signal.text}>
                  <span className="text-fg">{signal.text}</span>
                  <div className="text-[12px] text-fg-muted">{signal.basis}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-fg-muted">No measured diagnostic signals are available yet.</div>
          )}
          {b?.diagnostics?.pagespeed && !b.diagnostics.pagespeed.ok ? <p className="text-[12px] text-fg-muted">Mobile performance unavailable: {b.diagnostics.pagespeed.detail}.</p> : null}
          {b ? (
            <button type="button" className="justify-self-start text-[12px] text-fg-muted underline underline-offset-2" onClick={onOpenResearch}>
              The whole brief
            </button>
          ) : null}
        </div>

        <div className="grid content-start gap-1">
          <h3 className="text-[13px] font-semibold text-fg">Recommended architecture</h3>
          {opportunities.length ? (
            <ul className="grid gap-1.5">
              {opportunities.slice(0, SHOW).map((o) => (
                <li key={o.id}>
                  <span className="text-fg">{o.title}</span>
                  <div className="text-[12px] text-fg-muted">{o.what_it_does}</div>
                </li>
              ))}
            </ul>
          ) : options.length ? (
            <ul className="grid gap-3">
              {options.map(option => <li key={option.id}>
                <div className="font-medium text-fg">{option.title}</div>
                <div className="text-[12px] text-fg-muted">{option.question}</div>
                <div className="mt-1 text-[12px] tabular-nums text-fg">
                  {option.item ? `${option.item.name}: ${new Intl.NumberFormat("en-CA", { style: "currency", currency: option.item.currency, currencyDisplay: "code" }).format(option.item.price_cents! / 100)}${option.item.unit === "per_month" ? "/month" : ""} · confirmed catalogue price` : "Scope and price need confirmation in the catalogue."}
                </div>
              </li>)}
            </ul>
          ) : (
            <div className="text-fg-muted">
              Drafted after the call: once you approve the client&apos;s information, research runs and the audit and proposal are drafted from it. On the call, test the likely problems.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
