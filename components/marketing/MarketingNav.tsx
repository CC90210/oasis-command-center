"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";

/**
 * Public site navigation.
 *
 * Client component because it owns the mobile disclosure and reads the
 * active path. Deliberately small: the whole nav is six links and a sign-in.
 */

const LINKS = [
  { href: "/fleet", label: "Fleet" },
  { href: "/work", label: "Work" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
] as const;

export function MarketingNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close on navigation. Without this the sheet stays open over the new
  // page after a client-side transition.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes, and the page behind does not scroll while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const isActive = (href: string) => pathname === href;

  return (
    <header className="sticky top-0 z-50 border-b border-ops-line bg-ops-void/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label="OASIS AI, home">
          <OasisLogo size={30} priority />
          {/* Wordmark only. The "Montreal" sub-label read as a local
              agency's calling card; the company works internationally and
              the base is a legal detail, not a positioning statement. It
              still appears in the footer and on the legal pages, which is
              where a domicile belongs. */}
          <span className="font-display text-[17px] font-bold tracking-[0.01em] text-fg">
            OASIS AI
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? "page" : undefined}
              className={`px-3.5 py-2 text-[15px] font-medium tracking-[-0.01em] transition-colors ${
                isActive(l.href)
                  ? "text-fg"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/login"
            className="ml-3 px-3 py-2 text-[15px] font-medium tracking-[-0.01em] text-fg-muted transition-colors hover:text-fg"
          >
            Sign in
          </Link>
          <Link
            href="/contact"
            className="ml-1 rounded-md bg-signal px-4 py-2 text-[15px] font-semibold tracking-[-0.01em] text-ops-void transition-all hover:brightness-110"
          >
            Start
          </Link>
        </nav>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="m-nav-sheet"
          aria-label={open ? "Close menu" : "Open menu"}
          className="-mr-2 p-2 text-fg-muted transition-colors hover:text-fg md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile sheet. `hidden` rather than conditional render so the
          markup is stable and the ids aria-controls points at always exist. */}
      <div
        id="m-nav-sheet"
        hidden={!open}
        className="border-t border-ops-line bg-ops-void md:hidden"
      >
        <nav aria-label="Main" className="flex flex-col px-5 py-3">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? "page" : undefined}
              className={`border-b border-ops-line/60 py-3.5 text-[16px] font-medium ${
                isActive(l.href) ? "text-fg" : "text-fg-muted"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/login"
            className="border-b border-ops-line/60 py-3.5 text-[16px] font-medium text-fg-muted"
          >
            Sign in
          </Link>
          <Link
            href="/contact"
            className="mt-5 rounded-md bg-signal px-4 py-3 text-center text-[16px] font-semibold text-ops-void"
          >
            Start
          </Link>
        </nav>
      </div>
    </header>
  );
}
