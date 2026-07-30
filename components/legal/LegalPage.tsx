import Link from "next/link";
import { OasisLogo } from "@/components/brand/OasisLogo";
import {
  LEGAL_EFFECTIVE_DATE,
  LEGAL_ENTITY,
  LEGAL_CONTACTS,
  AI_DISCLOSURE_NOTICE,
} from "@/lib/legal/constants";

/**
 * Shared chrome for the three public legal routes (/privacy, /terms, /dmca).
 *
 * These render OUTSIDE the operator sidebar shell — they are pre-auth, public,
 * and linked from email footers and signup. Both app/layout.tsx
 * (FULL_BLEED_PREFIXES) and middleware.ts (PUBLIC_PATH_PREFIXES) must list
 * these paths or they 401 before the page renders.
 */
export function LegalPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[#02050a] text-[#f5f7fa]">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <Link href="/welcome" className="flex items-center gap-2.5">
            <OasisLogo size={24} />
            <span className="text-sm font-medium tracking-tight">{LEGAL_ENTITY}</span>
          </Link>
          <nav className="flex gap-5 text-sm text-white/55">
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/dmca" className="hover:text-white">DMCA</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-3 text-[15px] leading-relaxed text-white/60">{subtitle}</p>
        ) : null}
        <p className="mt-4 text-sm text-white/40">
          Effective {LEGAL_EFFECTIVE_DATE}
        </p>

        <div className="legal-prose mt-10">{children}</div>

        <footer className="mt-16 border-t border-white/10 pt-6 text-sm text-white/45">
          <p>{AI_DISCLOSURE_NOTICE}</p>
          <p className="mt-3">
            {LEGAL_ENTITY} · Montreal, Quebec, Canada ·{" "}
            <a
              className="text-white/70 underline underline-offset-2 hover:text-white"
              href={`mailto:${LEGAL_CONTACTS.legal}`}
            >
              {LEGAL_CONTACTS.legal}
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}

/** Numbered section heading + body, so each page reads as a real agreement. */
export function LegalSection({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-9">
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        <span className="mr-2 text-white/35 tabular-nums">{n}.</span>
        {title}
      </h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-white/75">
        {children}
      </div>
    </section>
  );
}

/** Emphasis block for clauses that must be conspicuous to be enforceable. */
export function LegalCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[14.5px] leading-relaxed text-amber-50/90">
      {children}
    </div>
  );
}
