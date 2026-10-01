/**
 * AddonCard — one of OASIS's own apps on Settings › Billing & add-ons.
 *
 * The app's own icon, what it does and what leaves the machine (from
 * components/settings/addons.ts, which quotes each app's README), and one
 * action that depends on whose workspace this is:
 *
 *   request  a client's workspace: ask OASIS to add it. There is no price,
 *            download or "installed" state, because nothing records any of
 *            those yet; the request goes to a person at OASIS through the
 *            same support form clients already use.
 *   built    OASIS's own workspace: it built the app, so "Ask OASIS" would
 *            file a ticket into its own desk (S1-A2). The card says so and
 *            links the app's install guide instead.
 *
 * Server component, no hooks.
 */

import Image from "next/image";
import type { AddonDef } from "@/components/settings/addons";

export type AddonCardMode = "request" | "built";

export function AddonCard({
  addon,
  mode,
  requestHref,
}: {
  addon: AddonDef;
  mode: AddonCardMode;
  /** The support form, for `request`. */
  requestHref?: string;
}) {
  return (
    <li className="flex flex-col rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-start gap-3 px-4 pt-4">
        <Image
          src={addon.icon}
          alt=""
          width={44}
          height={44}
          className="h-11 w-11 shrink-0 rounded-xl border border-hairline bg-bg-raised object-cover"
        />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{addon.name}</h3>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{addon.summary}</p>
          <p className="mt-0.5 text-[12px] leading-4 text-fg-dim">{addon.platforms}</p>
        </div>
      </header>
      <ul className="mt-3 space-y-1.5 px-4 text-[13px] leading-5 text-fg">
        {addon.facts.map((f) => (
          <li key={f} className="flex gap-2">
            <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-fg-dim" />
            {f}
          </li>
        ))}
      </ul>
      <p className="mb-4 mt-3 px-4 text-[12px] leading-5 text-fg-muted">
        <span className="font-medium text-fg">Privacy: </span>
        {addon.privacy}
      </p>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3">
        {mode === "built" ? (
          <>
            <span className="text-[12px] text-fg-dim">Built by OASIS</span>
            <a
              href={addon.installGuide.href}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              aria-label={`${addon.name} install guide`}
            >
              {addon.installGuide.label}
            </a>
          </>
        ) : (
          <>
            <span className="text-[12px] text-fg-dim">Added by OASIS on request</span>
            <a
              href={requestHref}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              aria-label={`Ask OASIS to add ${addon.name}`}
            >
              Ask OASIS to add this
            </a>
          </>
        )}
      </footer>
    </li>
  );
}
