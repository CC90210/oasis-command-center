"use client";

/**
 * Global error boundary: catches errors thrown in the ROOT layout itself
 * (where error.tsx can't help because the layout is the boundary).
 *
 * This must include its own <html><body> shell since the parent layout
 * has already failed, and its own styles, since the stylesheet the layout
 * imports may not have loaded. The help copy is components/ErrorHelp.tsx,
 * shared with app/error.tsx: try again, then send us the code; on a page a
 * client's prospect opens (/f/, /sign/, /unsubscribe), no OASIS contact.
 *
 * The button is the OS button class (.btn-primary, app/globals.css) AND an
 * inline style that references the same tokens with their values as fallbacks
 * (2026-10-01, OS plan W0). The only path this file exists for is the one
 * where the root layout, the sole importer of globals.css, has failed: without
 * the inline fallbacks the class names nothing and the button is the browser
 * default (light grey, black text) on this dark body. With the stylesheet the
 * token wins; without it the fallback is the token's own value
 * (--c-accent-muted: 37 99 235, globals.css). No second palette either way.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { ErrorHelp, isProspectFacingPath } from "@/components/ErrorHelp";
import { isReadDeadlineDigest } from "@/lib/os/deadline";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const prospectFacing = isProspectFacingPath(usePathname());
  const timedOut = isReadDeadlineDigest(error.digest);
  useEffect(() => {
    console.error("[global-error.tsx]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: "#020409",
          color: "#f5f7fa",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
          minHeight: "100vh",
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            padding: "1.75rem",
            borderRadius: 16,
            border: "1px solid #1e2532",
            background: "#0b0f17",
          }}
        >
          <h1 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>
            {timedOut ? "This page timed out" : "Something went wrong"}
          </h1>
          <ErrorHelp digest={error.digest} inline prospectFacing={prospectFacing} timedOut={timedOut} />
          <button
            onClick={() => (timedOut ? window.location.reload() : reset())}
            className="btn-primary"
            style={{
              marginTop: "1rem",
              cursor: "pointer",
              background: "rgb(var(--c-accent-muted, 37 99 235))",
              color: "#ffffff",
              fontWeight: 600,
              padding: "0.5rem 0.95rem",
              borderRadius: "0.5rem",
              border: 0,
              fontSize: "0.875rem",
            }}
          >
            {timedOut ? "Reload" : "Try again"}
          </button>
        </div>
      </body>
    </html>
  );
}
