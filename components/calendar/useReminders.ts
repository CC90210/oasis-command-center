"use client";

/**
 * Fires event reminders while the page is open: an in-page toast always, and
 * a desktop notification when the viewer has allowed them. Nothing leaves the
 * browser; there is no server push, and the settings dialog says so.
 */

import { useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/calendar/dates";
import type { Occurrence } from "@/lib/calendar/types";

const HORIZON_MS = 12 * 3_600_000;

export type ReminderPermission = NotificationPermission | "unsupported";

export function useReminders(occurrences: Occurrence[], onRemind: (text: string) => void) {
  const fired = useRef(new Set<string>());
  const cb = useRef(onRemind);
  cb.current = onRemind;
  const [permission, setPermission] = useState<ReminderPermission>("default");

  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const o of occurrences) {
      if (o.allDay) continue;
      for (const minutes of o.event.reminders) {
        const at = o.start.getTime() - minutes * 60_000;
        const id = `${o.key}|${minutes}`;
        if (at < now - 60_000 || at > now + HORIZON_MS || fired.current.has(id)) continue;
        timers.push(
          setTimeout(() => {
            if (fired.current.has(id)) return;
            fired.current.add(id);
            const title = o.event.title || "(No title)";
            const text = minutes === 0 ? `${title} is starting now` : `${title} at ${formatTime(o.start)}`;
            cb.current(text);
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              try {
                new Notification(title, { body: text, tag: id });
              } catch {
                /* The in-page toast already carried it. */
              }
            }
          }, Math.max(0, at - now)),
        );
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [occurrences]);

  const request = async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  };

  return { permission, request };
}
