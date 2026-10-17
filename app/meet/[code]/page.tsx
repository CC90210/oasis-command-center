import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { MeetEnded } from "@/components/meet/MeetEnded";
import { MeetRoom } from "@/components/meet/MeetRoom";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTursoClient } from "@/lib/turso";
import { loadMeetPage, sessionOrVisitor } from "./load";

/**
 * oasisai.work/meet/abc-defg-hjk - an Oasis Meet room (CC, 2026-10-17: "you send people specific links, and
 * they can join the meeting").
 *
 * Public: a guest has no account. The page itself holds no meeting data beyond the title and whether it
 * records; everything after the first screen comes from /api/meet/<code>/*, which checks a participant token
 * or the host's session on every call (lib/meet/handlers.ts). It draws without the app shell (lib/os/full-bleed.ts).
 *
 * Who is looking decides one thing: a host and a member of the room's workspace may leave their name empty (the
 * server uses their account), a visitor must give one, and in a recorded room everyone but the host ticks the
 * recording notice before the camera step appears (components/meet/notice.ts).
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
      return <MeetRoom {...data.props} />;
  }
}
