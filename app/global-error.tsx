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
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { ErrorHelp, isProspectFacingPath } from "@/components/ErrorHelp";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const prospectFacing = isProspectFacingPath(usePathname());
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
            Something went wrong
          </h1>
          <ErrorHelp digest={error.digest} inline prospectFacing={prospectFacing} />
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1rem",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              border: "1px solid rgba(59,130,246,0.3)",
              background: "#3b82f6",
              color: "#020409",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
