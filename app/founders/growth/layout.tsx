import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveFounder } from "@/lib/founders/gate";
import { GROWTH_SECTIONS } from "@/lib/founders/growth-shell";

export default async function GrowthLayout({ children }: { children: React.ReactNode }) {
  // Defence in depth: keep this gate even though app/founders/layout.tsx also
  // checks it. A future layout move must fail closed rather than expose a route.
  if (!(await resolveFounder())) notFound();

  return (
    <div className="space-y-6">
      <nav aria-label="Marketing sections" className="flex flex-wrap gap-2">
        {GROWTH_SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="rounded-full border border-cyan-400/25 px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-cyan-300/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
          >
            {section.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
