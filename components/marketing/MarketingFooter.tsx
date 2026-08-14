import Link from "next/link";
import { OasisLogo } from "@/components/brand/OasisLogo";
import {
  AI_DISCLOSURE_NOTICE,
  LEGAL_ENTITY,
  LEGAL_PRINCIPAL_PLACE,
} from "@/lib/legal/constants";
import { CONTACT_EMAIL } from "@/lib/marketing/routes";

/**
 * Public footer.
 *
 * Entity name, location, contacts, and the AI disclosure all come from
 * lib/legal/constants.ts rather than being typed here. That file is the
 * audited source of truth for the legal pages, and the disclosure is
 * required to appear in the public footer — duplicating either as a string
 * literal is how a footer ends up quietly contradicting /privacy.
 */

const SITE_LINKS = [
  { href: "/fleet", label: "The fleet" },
  { href: "/work", label: "What we build" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

const PLATFORM_LINKS = [
  { href: "/start", label: "Start here" },
  { href: "/login", label: "Sign in" },
  { href: "/download", label: "Desktop app" },
];

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/dmca", label: "DMCA" },
];

export function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-ops-line bg-ops-void">
      <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            {/* HARD navigation, deliberately — see SHELL_BOUNDARY_NOTE in
            lib/marketing/routes.ts. "/" is marketing for a visitor and the
            dashboard for a signed-in operator, so a <Link> here soft-navigates
            across the shell boundary and the root layout, being a Server
            Component, never re-renders: CC lands on the dashboard with the
            marketing chrome still applied and no sidebar. That is the
            "super zoomed in and warped, fixed by refreshing" report. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load is the POINT here; see the note above. */}
            <a href="/" className="inline-flex items-center gap-3">
              <OasisLogo size={28} />
              <span className="font-display text-[13px] font-bold tracking-[0.14em] text-fg">
                OASIS AI
              </span>
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fg-muted">
              Operational Agentic Systems Increasing Scalability. Agents that
              hold a seat in your business, and the systems they run on.
            </p>
            <p className="mt-4 text-[13px] text-fg-dim">
              Working internationally
              <span className="mt-1 block text-fg-faint">
                Registered in {LEGAL_PRINCIPAL_PLACE}
              </span>
            </p>
          </div>

          <FooterColumn title="Company" links={SITE_LINKS} />
          <FooterColumn title="Platform" links={PLATFORM_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_LINKS} />
        </div>

        <div className="mt-12 border-t border-ops-line pt-8">
          <p className="max-w-3xl text-xs leading-relaxed text-fg-dim">
            {AI_DISCLOSURE_NOTICE}
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[14px] text-fg-dim">
              © {year} {LEGAL_ENTITY}
            </p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-[14px] text-fg-muted transition-colors hover:text-signal"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="font-data text-[10px] uppercase tracking-[0.24em] text-fg-dim">
        {title}
      </h2>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="text-sm text-fg-muted transition-colors hover:text-fg"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
