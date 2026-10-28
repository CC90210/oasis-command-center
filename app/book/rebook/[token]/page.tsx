import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/app/(marketing)/marketing.css";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import { RebookPage } from "@/components/booking/RebookPage";
import { readRebookState } from "@/lib/booking/rebook";
import { RebookNotConfiguredError } from "@/lib/booking/rebook-token";
import { PUBLIC_BOOKING_TIME_ZONE } from "@/lib/forms/public-booking";
import { getServiceSupabase } from "@/lib/supabase-server";

/**
 * oasisai.work/book/rebook/<token> - a lead whose founder meeting did not happen
 * picks a new time (CC, 2026-10-28). The token is signed for one appointment
 * (lib/booking/rebook-token.ts); lib/booking/rebook.ts decides what it opens
 * to: the calendar ("open"), the time it is already moved to ("booked"), or a
 * reply-to-us note ("closed"). Never says WHY a link is closed: the reason is
 * logged, the visitor gets one plain sentence.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pick a new time | OASIS AI",
  description: "Pick a new time for your call with OASIS AI.",
  // A personal link: never indexed, never followed.
  robots: { index: false, follow: false },
};

const when = (iso: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: PUBLIC_BOOKING_TIME_ZONE, ...options }).format(new Date(iso));

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className={`marketing ${offerFontVariables} min-h-screen bg-ops-void font-body text-fg antialiased`}>{children}</div>
  );
}

function Note({ eyebrow, title, body, link }: { eyebrow: string; title: string; body: string; link?: { href: string; label: string } }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-20">
      <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">{eyebrow}</p>
      <h1 className="mt-5 font-display text-3xl font-semibold tracking-[-0.02em] text-fg">{title}</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">{body}</p>
      {link ? (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 inline-flex w-fit items-center justify-center rounded-md bg-signal px-6 py-3 text-[15px] font-semibold text-ops-void hover:brightness-110"
        >
          {link.label}
        </a>
      ) : null}
    </main>
  );
}

export default async function RebookRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let state: Awaited<ReturnType<typeof readRebookState>>;
  try {
    state = await readRebookState(getServiceSupabase(), decodeURIComponent(token));
  } catch (error) {
    // No signing key is an outage to fix, never a dead link shown as "expired".
    if (error instanceof RebookNotConfiguredError) throw new Error("rebook links unavailable: signing key not set");
    throw error;
  }

  if (state.state === "booked") {
    return (
      <Shell>
        <Note
          eyebrow="Booked"
          title="Your call is on our calendar."
          body={`${when(state.startsAt, { weekday: "long", month: "long", day: "numeric" })} at ${when(state.startsAt, {
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          })}. The calendar invite in your inbox has the video call link.`}
          link={state.meetUrl ? { href: state.meetUrl, label: "Open the video call" } : undefined}
        />
      </Shell>
    );
  }
  if (state.state === "closed") {
    console.info("[rebook.page] closed link", { reason: state.reason });
    return (
      <Shell>
        <Note
          eyebrow="OASIS AI"
          title="This link can no longer book a time."
          body="Reply to our last email and we will set up a time that works for you."
        />
      </Shell>
    );
  }
  return (
    <Shell>
      <RebookPage
        token={decodeURIComponent(token)}
        firstName={state.firstName}
        offerLabel={state.offerLabel}
        durationMinutes={state.durationMinutes}
        missedAt={state.missedAt}
      />
    </Shell>
  );
}
