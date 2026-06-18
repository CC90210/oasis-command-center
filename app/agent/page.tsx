/**
 * /agent — the Agents tab route.
 *
 * As of 2026-06-18 the ChatWidget is NO LONGER mounted here. It lives in the
 * persistent shell (components/MainShell.tsx), which renders one ChatWidget
 * instance that survives soft navigation so a running agent keeps running when
 * you click away and back. Props are resolved server-side in app/layout.tsx
 * via lib/chat-shell-props.ts and threaded into MainShell.
 *
 * This route only needs to EXIST so /agent is a valid path (and so MainShell's
 * pathname check renders the chat full-screen here). The persistent chat is a
 * `fixed`, z-20 overlay above this <main>, so the fallback below is visible
 * only if the persistent chat couldn't mount — e.g. a brand-new tenant with no
 * agent enabled yet (chat props resolve to null).
 *
 * Mounting a ChatWidget here again would create a SECOND competing instance
 * (double stream, orphaned warm-pool tab) — don't. See MainShell.
 */

export default function ClientAgentPage() {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center text-center">
      <div className="max-w-sm space-y-2 px-6">
        <p className="text-sm text-fg-dim">Loading your agent workspace…</p>
        <p className="text-xs text-fg-faint">
          If this message stays, your workspace doesn&apos;t have an agent
          enabled yet — an operator can enable one in Settings.
        </p>
      </div>
    </div>
  );
}
