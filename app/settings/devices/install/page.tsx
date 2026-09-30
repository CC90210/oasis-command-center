/**
 * /settings/devices/install — dedicated wizard page for the bridge install
 * flow. The same pairing flow lives inside DevicesEditor's "Install" button
 * on /settings, but deep-linking from "API key mode is great, but you want
 * full Claude Code? Install the bridge →" is much cleaner against its own
 * URL than against a modal-trigger button.
 *
 * Server-component shell — auth + headline copy. The actual pairing UX is
 * a client component (InstallBridgeWizard) so the polling, OS detection,
 * and clipboard interactions can run client-side.
 *
 * Operator only since 2026-09-29 (F0 containment). The full install pulls the
 * harness repo, which went private that day, and Settings › Devices is already
 * operator-only for the same reason: the bridge gives an agent a shell on the
 * paired machine. A verified platform operator (resolvePlatformOperator) gets
 * the wizard, with the repo name passed in from here. Any other signed-in
 * viewer, a client included, gets a private-beta notice with no command, no
 * pair code and no repository name, and the support form to ask for access,
 * the same answer /download gives. Pinned by tests/f0-containment.test.ts.
 */

import Link from "next/link";
import { ArrowLeft, Cloud, Cpu } from "lucide-react";
import { PageHeader } from "@/components/Card";
import { getSessionUser } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";
import { HARNESS_REPO } from "@/lib/install-scripts";
import { InstallBridgeWizard } from "./InstallBridgeWizard";

export const dynamic = "force-dynamic";

export default async function BridgeInstallPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/settings/devices/install");
  // Fails closed: a membership lookup error is logged inside and answers "not
  // an operator", which renders the private-beta notice.
  const op = await resolvePlatformOperator();

  const header = (
    <PageHeader
      title="Install the local bridge"
      subtitle="Give your agents full Claude Code parity — file system, bash, every MCP — by pairing this machine to your tenant."
      action={
        <Link
          href="/settings#devices"
          className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-3 h-3" /> Back to Settings
        </Link>
      }
    />
  );

  if (!op.operator) {
    return (
      <div className="space-y-6 animate-fade-in">
        {header}
        <BridgePrivateBeta />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {header}

      {/* Side-by-side capability comparison so the operator sees exactly
          what installing the bridge unlocks vs. cloud-only mode. */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Cloud className="w-4 h-4 text-fg-muted" />
            <div className="text-xs font-bold uppercase tracking-wider text-fg-muted">
              Cloud only (API key)
            </div>
          </div>
          <div className="text-sm text-fg mb-2">What you have now</div>
          <ul className="text-xs text-fg-muted space-y-1.5 leading-relaxed">
            <li>• Native Anthropic tool_use loop</li>
            <li>• Records read / write / search / delete</li>
            <li>• http_get and http_post against public URLs</li>
            <li>• Integration status + lead lookup</li>
            <li className="text-fg-dim italic">
              No local file access, no shell, no MCPs
            </li>
          </ul>
        </div>
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-4 h-4 text-accent" />
            <div className="text-xs font-bold uppercase tracking-wider text-accent">
              Local bridge (Claude Code CLI)
            </div>
          </div>
          <div className="text-sm text-fg mb-2">What the install unlocks</div>
          <ul className="text-xs text-fg-muted space-y-1.5 leading-relaxed">
            <li>• Read / Edit / Write / Bash / Glob / Grep on your repos</li>
            <li>• All Claude Code MCPs (Playwright, Supabase, Context7…)</li>
            <li>• Python scripts and scheduled cron jobs</li>
            <li>• Real SMS / email sends via your local .env.agents</li>
            <li className="text-accent">
              Uses your Claude Code subscription (no per-token API charges)
            </li>
          </ul>
        </div>
      </div>

      <InstallBridgeWizard installRepo={HARNESS_REPO} />
    </div>
  );
}

/** What a signed-in viewer who is not the verified platform operator sees. */
function BridgePrivateBeta() {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-5 space-y-3">
      <h2 className="text-base font-bold text-fg">The local bridge is in private beta</h2>
      <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
        The bridge lets your agents work with the files and tools on a computer
        you pair. While it is in beta, OASIS sets it up with each workspace
        directly, so there is no install command here yet.
      </p>
      {/* A plain <a>: the support form renders outside the dashboard shell. */}
      <a href={SUPPORT_FORM_PATH} className="btn-primary inline-flex items-center gap-2">
        Ask for access
      </a>
    </div>
  );
}
