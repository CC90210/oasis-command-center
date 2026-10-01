"use client";

/**
 * Root error boundary. Next.js renders this when ANY server component
 * inside the dashboard shell throws, instead of the framework's default
 * stark white page.
 *
 * Most readers in /today, /pipeline, /analytics, etc are wrapped in
 * `safe(p, fallback)` so individual queries can't get here. This catches
 * the residual class: a bug in render code, a misconfigured env, a
 * database outage that takes the whole call down.
 *
 * Clients see this page too, so it speaks to a person who cannot read a log:
 * what to try, and where to send the code. It used to tell them to check the
 * hosting provider's function logs, which only an operator can open. The digest
 * stays because it is the one thing that lets us find the failure in the
 * Worker's logs from their message.
 *
 * It is also the boundary for the public pages a client's own prospects open
 * (/f/<client>/<form>, /sign/<token>, /unsubscribe): there it names no OASIS
 * contact and drops the link to Today, an operator page (components/ErrorHelp.tsx).
 *
 * A READ DEADLINE is the one failure it can name (2026-10-01, OS plan W0). A
 * Today read that does not answer inside its budget rejects with a
 * ReadDeadlineError (lib/os/deadline.ts) whose digest survives Next's
 * production redaction, so this page can say "a workspace read timed out" and
 * offer a reload instead of the generic copy. The read's label never reaches
 * the viewer; it is in the Worker's logs.
 */

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { ErrorHelp, isProspectFacingPath } from "@/components/ErrorHelp";
import { isReadDeadlineDigest } from "@/lib/os/deadline";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const prospectFacing = isProspectFacingPath(usePathname());
  const timedOut = isReadDeadlineDigest(error.digest);
  useEffect(() => {
    // The Worker's logs capture console output; this is the diagnostic record.
    console.error("[error.tsx]", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6 py-16">
      <div className="max-w-md w-full rounded-2xl border border-status-warm/30 bg-bg-elev p-7 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-status-warm/15 border border-status-warm/30 flex items-center justify-center text-status-warm">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <h1 className="text-base font-bold text-fg">{timedOut ? "This page timed out" : "Something went wrong"}</h1>
        </div>
        <ErrorHelp digest={error.digest} prospectFacing={prospectFacing} timedOut={timedOut} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {timedOut ? (
            // A full reload, not reset(): the read is started over from the
            // server rather than re-rendering the segment that just hung.
            <button
              onClick={() => window.location.reload()}
              className="btn-primary inline-flex items-center gap-1.5 text-sm"
            >
              <RefreshCw className="w-4 h-4" /> Reload
            </button>
          ) : (
            <button
              onClick={() => reset()}
              className="btn-primary inline-flex items-center gap-1.5 text-sm"
            >
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          )}
          {prospectFacing ? null : (
            <Link href="/" className="btn-secondary inline-flex items-center gap-1.5 text-sm">
              <Home className="w-4 h-4" /> Today
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
