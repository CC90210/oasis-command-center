import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { MeetEnded } from "@/components/meet/MeetEnded";
import { MeetRoomLive } from "@/components/meet/MeetRoomLive";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient } from "@/lib/turso";
import { loadMeetPage, sessionOrVisitor } from "./load";

/**
 * oasisai.work/meet/abc-defg-hjk - an Oasis Meet room (CC, 2026-10-17: "you send people specific links, and
 * they can join the meeting").
 *
 * Public: a guest has no account. The page itself holds no meeting data beyond the title, whether it records, when
 * it is for and, for a meeting a lead booked, that lead's first name (app/meet/[code]/load.ts: anyone who holds the
 * link sees this page); everything after the first screen comes from /api/meet/<code>/*, which checks a participant
 * token or the host's session on every call (lib/meet/handlers.ts). It draws without the app shell (lib/os/full-bleed.ts).
 *
 * Who is looking decides two things: a host and a member of the room's workspace may leave their name empty (the
 * server uses their account) and a visitor must give one, starting with the booked lead's first name when there is
 * one; and whether they made the room decides the recording notice: in a recorded room everyone but its creator, a
 * second host too, ticks it before the camera step appears (components/meet/notice.ts).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Oasis Meet",
  // A meeting link is shared with the people meant to join, not found by search.
  robots: { index: false, follow: false },
};

export default async function MeetPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const data = await loadMeetPage(code, { db: getTursoClient, session: () => sessionOrVisitor(resolveSessionContext) });
  switch (data.kind) {
    case "not_found":
      notFound();
    case "redirect":
      redirect(data.to);
    case "ended":
      return <MeetEnded reason="room_closed" isHost={data.viewer === "host"} />;
    case "room":
      return <MeetRoomLive {...data.props} />;
  }
}
