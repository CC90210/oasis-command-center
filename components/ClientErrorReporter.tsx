"use client";

/**
 * Reports browser errors no error boundary sees: an exception in an event
 * handler or a timer, and a promise nobody awaited. Error boundaries
 * (app/error.tsx, app/global-error.tsx) report what they catch themselves.
 *
 * Only errors from our own scripts are sent: an error event whose script URL
 * is another origin (a browser extension, an embedded widget) says nothing
 * about this app. Delivery, dedupe and caps: lib/client-errors/report.ts.
 */

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-errors/report";

function fromOurOrigin(filename: string | undefined): boolean {
  if (!filename) return true; // inline/eval errors carry no filename; keep them
  try {
    return new URL(filename, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (!fromOurOrigin(event.filename)) return;
      reportClientError("window", event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      // A fetch aborted by a navigation or an unmount is not a crash.
      const reason = event.reason as { name?: unknown } | null | undefined;
      if (reason && reason.name === "AbortError") return;
      reportClientError("rejection", event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
