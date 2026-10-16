"use client";

/**
 * What a visitor sees at a public form link that has nothing to show: a form
 * that is switched off, a page not published yet, or a mistyped or retired
 * link (app/f/not-found.tsx). Before this, /f/* fell through to the signed-in
 * app's page ("That page doesn't exist in your workspace. Back to Today"),
 * which told a stranger about a workspace and pointed them into the app.
 *
 * /f/ serves every workspace's forms, so the page is neutral for all of them.
 * Only OASIS's own links (/f/oasis-ai-cc/...) get the way forward OASIS
 * offers: book a call, or visit the site. A client's visitor is never sent to
 * OASIS. tests/public-form-not-found.test.ts pins the slug to
 * lib/forms/oasis-ai-audit-seed.ts AI_AUDIT_TENANT_SLUG; it is a literal here
 * so this client component does not bundle the seed.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const OASIS_FORMS_PREFIX = "/f/oasis-ai-cc/";

export function PublicFormNotFound() {
  const pathname = usePathname() || "";
  const isOasis = pathname.startsWith(OASIS_FORMS_PREFIX);

  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-bg px-6 py-16">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-bg-border bg-bg-elev p-7 text-center">
        <h1 className="text-lg font-bold text-fg">This page isn&apos;t available</h1>
        <p className="text-sm text-fg-muted">The link may be out of date, or the page isn&apos;t open yet.</p>
        {isOasis ? (
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Link href="/book" className="btn-primary text-sm">
              Book a call
            </Link>
            {/* "/" is the dashboard for a signed-in visitor: a full load, see SHELL_BOUNDARY_NOTE in lib/marketing/routes.ts. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load is the POINT here; see the note above. */}
            <a href="/" className="btn-secondary text-sm">
              Visit OASIS AI
            </a>
          </div>
        ) : (
          <p className="text-sm text-fg-muted">If someone sent you this link, ask them for a new one.</p>
        )}
      </div>
    </main>
  );
}
