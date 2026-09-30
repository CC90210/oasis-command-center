/**
 * /agent — Admin › Coding harness (2026-09-30; was "Agent console").
 *
 * OPERATOR ONLY. It runs Claude Code, Codex or Gemini in a department's repo
 * on the operator's computer through the bridge (Business-Empire-Agent for
 * Chief of Staff and Operations, CMO-Agent for Marketing, CFO-Agent for
 * Finance). Anyone else is sent to Chief of Staff, where everyday questions
 * belong; the department channels are the product, this is the operator's
 * workbench.
 *
 * The chat itself is NOT mounted here. It lives in the persistent shell
 * (components/MainShell.tsx), which renders one ChatWidget that survives soft
 * navigation, with the runner header above it. Props come from
 * lib/chat-shell-props.ts via app/layout.tsx. This route only has to exist so
 * /agent is a valid path; its body shows only if the shell's chat could not
 * mount. Mounting a second ChatWidget here would double every stream.
 */

import { redirect } from "next/navigation";
import { isPlatformOperator } from "@/lib/role-surfaces-session";
import { ASK_HREF } from "@/lib/os/nav";

export const dynamic = "force-dynamic";

export default async function CodingHarnessPage() {
  if (!(await isPlatformOperator())) redirect(ASK_HREF);
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center text-center">
      <div className="max-w-sm space-y-2 px-6">
        <p className="text-sm text-fg-muted">Loading the Coding harness…</p>
        <p className="text-xs text-fg-dim">
          If this stays, the harness could not load for your workspace. Reload the page; the reason is in the server log.
        </p>
      </div>
    </div>
  );
}
