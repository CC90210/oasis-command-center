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
 */

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { ErrorHelp } from "@/components/ErrorHelp";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
          <h1 className="text-base font-bold text-fg">Something went wrong</h1>
        </div>
        <ErrorHelp digest={error.digest} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => reset()}
            className="btn-primary inline-flex items-center gap-1.5 text-sm"
          >
            <RefreshCw className="w-4 h-4" /> Try again
          </button>
          <Link href="/" className="btn-secondary inline-flex items-center gap-1.5 text-sm">
            <Home className="w-4 h-4" /> Today
          </Link>
        </div>
      </div>
    </div>
  );
}
