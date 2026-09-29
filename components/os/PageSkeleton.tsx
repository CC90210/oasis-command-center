/**
 * PageSkeleton — what a page shows the instant it is clicked, while its server
 * components fetch (every `loading.tsx` renders one). Without one, Next keeps
 * the OLD page on screen until the new one arrives, so a click looks ignored.
 *
 * Shapes only, never numbers or labels: a placeholder that looks like data
 * would be read as data. `variant` matches the page's layout so nothing jumps
 * when the real content lands:
 *   page     title, a row of tiles, two blocks (a landing or department page)
 *   section  title and two cards (a Settings section, a portal tab)
 */

export function PageSkeleton({ variant = "page" }: { variant?: "page" | "section" }) {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="space-y-2">
        <div className="h-7 w-48 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-72 max-w-full rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {variant === "page" && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl border border-bg-border bg-bg-elev/60 animate-pulse-slow" />
          ))}
        </div>
      )}
      <div
        className={`rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow ${variant === "page" ? "h-72" : "h-40"}`}
      />
      <div
        className={`rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow ${variant === "page" ? "h-48" : "h-32"}`}
      />
    </div>
  );
}
