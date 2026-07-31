import Link from "next/link";
import {
  LEGAL_EFFECTIVE_DATE,
  LEGAL_ENTITY,
  LEGAL_PRINCIPAL_PLACE,
  LEGAL_CONTACTS,
  AI_DISCLOSURE_NOTICE,
} from "@/lib/legal/constants";

/**
 * Shared chrome for the three public legal routes (/privacy, /terms, /dmca).
 *
 * These pages live in app/(marketing)/ and therefore already have the site
 * header, footer, and <main> from app/(marketing)/layout.tsx. This
 * component supplies ONLY the document chrome — title, effective date,
 * cross-links, and the prose wrapper. It deliberately renders no <main>,
 * no logo, and no site footer of its own; it used to, and moving these
 * routes into the marketing shell without stripping them would have
 * produced two navs, two footers, and nested landmarks.
 *
 * The COPY is not this component's business. Every fact rendered here
 * comes from lib/legal/constants.ts, which is the audited source of truth
 * and is asserted against docs/compliance/PRIVACY_NUTRITION_LABEL.json by
 * tests/legal-compliance-drift.test.ts. Restyling is safe; retyping any of
 * these strings as a literal is not.
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
    <article className="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <nav
        aria-label="Legal documents"
        className="flex gap-5 border-b border-ops-line pb-5"
      >
        {[
          { href: "/privacy", label: "Privacy" },
          { href: "/terms", label: "Terms" },
          { href: "/dmca", label: "DMCA" },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim transition-colors hover:text-signal"
          >
            {l.label}
          </Link>
        ))}
      </nav>

      <h1 className="mt-10 font-display text-[clamp(1.9rem,4vw,2.6rem)] font-bold tracking-tight text-fg">
        {title}
      </h1>
      {subtitle ? (
        <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">{subtitle}</p>
      ) : null}
      <p className="mt-4 font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">
        Effective {LEGAL_EFFECTIVE_DATE}
      </p>

      {/* The AI disclosure sits at the TOP of these pages by design — a
          disclosure a reader reaches only after the agreement they were
          meant to read it before is decorative. It also appears in the site
          footer; that duplication is the documented contract in
          lib/legal/constants.ts, not an oversight. */}
      <p className="mt-8 border-l-2 border-signal-dim bg-signal-wash px-5 py-4 text-[14px] leading-relaxed text-fg-muted">
        {AI_DISCLOSURE_NOTICE}
      </p>

      <div className="legal-prose mt-12">{children}</div>

      <footer className="mt-16 border-t border-ops-line pt-6 text-sm text-fg-dim">
        <p>
          {LEGAL_ENTITY} · {LEGAL_PRINCIPAL_PLACE} ·{" "}
          <a
            className="text-fg-muted underline underline-offset-2 transition-colors hover:text-signal"
            href={`mailto:${LEGAL_CONTACTS.legal}`}
          >
            {LEGAL_CONTACTS.legal}
          </a>
        </p>
      </footer>
    </article>
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
      <h2 className="mb-3 font-display text-lg font-bold tracking-tight text-fg">
        <span className="mr-2 tabular-nums text-fg-faint">{n}.</span>
        {title}
      </h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-fg-muted">
        {children}
      </div>
    </section>
  );
}

/** Emphasis block for clauses that must be conspicuous to be enforceable. */
export function LegalCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 border border-status-warm/30 bg-status-warm/[0.06] p-4 text-[14.5px] leading-relaxed text-amber-50/90">
      {children}
    </div>
  );
}
