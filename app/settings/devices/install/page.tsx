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
 * Split by viewer since 2026-09-29 (F0 containment). The full install pulls
 * the harness repo, which went private that day, and Settings › Devices is
 * already operator-only for the same reason: the bridge gives an agent a shell
 * on the paired machine. A verified platform operator (resolvePlatformOperator)
 * gets the full wizard, with the repo name passed in from here.
 *
 * Every other signed-in viewer, a client included, gets pair-only mode
 * (PairBridgeOnly): a one-time code and the self-contained command that links
 * a computer which already has the bridge. It clones nothing, and the page
 * carries no install command, no repository name and nothing the harness
 * names. Beside it, the private-beta notice says a new install is done by
 * OASIS, with the support form to ask for one. Pinned by
 * tests/f0-containment.test.ts.
 */

import Link from "next/link";
import { ArrowLeft, Cloud, Cpu } from "lucide-react";
import { PageHeader } from "@/components/Card";
import { getSessionUser } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";
import { setupHref } from "@/lib/setup-links";
import { HARNESS_REPO } from "@/lib/install-scripts";
import { InstallBridgeWizard } from "./InstallBridgeWizard";
import { PairBridgeOnly } from "./PairBridgeOnly";

export const dynamic = "force-dynamic";

export default async function BridgeInstallPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/settings/devices/install");
  // Fails closed: a membership lookup error is logged inside and answers "not
  // an operator", which renders the pair-only page.
  const op = await resolvePlatformOperator();

  const back = (
    <Link
      href={op.operator ? setupHref("bridge_devices") : setupHref("profile")}
      className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
    >
      <ArrowLeft className="w-3 h-3" /> Back to Settings
    </Link>
  );

  if (!op.operator) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader
          title="Pair the local bridge"
          subtitle="Link a computer that already has the OASIS bridge to your workspace, so your agents can work with its files and tools."
          action={back}
        />
        <PairBridgeOnly />
        <BridgePrivateBeta />
      </div>
    );
  }

  const header = (
    <PageHeader
      title="Connect a computer to OASIS AI Command Center"
      subtitle="Your agents can then run automations, use its terminal and files, and start the AI command-line tools installed on it, whatever model they use."
      action={back}
    />
  );

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
              Cloud only (your AI account)
            </div>
          </div>
          <div className="text-sm text-fg mb-2">What you have now</div>
          <ul className="text-xs text-fg-muted space-y-1.5 leading-relaxed">
            <li>&bull; Records read / write / search / delete</li>
            <li>&bull; http_get and http_post against public URLs</li>
            <li>&bull; Integration status + lead lookup</li>
            <li className="text-fg-dim italic">
              No access to a computer&apos;s files, terminal or local tools
            </li>
          </ul>
        </div>
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-4 h-4 text-accent" />
            <div className="text-xs font-bold uppercase tracking-wider text-accent">
              With a connected computer
            </div>
          </div>
          <div className="text-sm text-fg mb-2">What connecting adds</div>
          <ul className="text-xs text-fg-muted space-y-1.5 leading-relaxed">
            <li>&bull; Reads and edits files, and runs terminal commands, on that computer</li>
            <li>&bull; Scripts and scheduled jobs</li>
            <li>&bull; Chat through an AI command-line tool installed there, from Anthropic, OpenAI or Google</li>
          </ul>
        </div>
      </div>

      <InstallBridgeWizard installRepo={HARNESS_REPO} />
    </div>
  );
}

/** Beside the pair-only card for everyone who is not the verified platform operator: how a NEW computer gets the bridge. */
function BridgePrivateBeta() {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-5 space-y-3">
      <h2 className="text-base font-bold text-fg">The local bridge is in private beta</h2>
      <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
        Pairing above is for a computer that already has the bridge. Installing
        it on a new computer is done by OASIS with each workspace while the
        bridge is in beta, so there is no install command here.
      </p>
      {/* A plain <a>: the support form renders outside the dashboard shell. */}
      <a href={SUPPORT_FORM_PATH} className="btn-primary inline-flex items-center gap-2">
        Ask for access
      </a>
    </div>
  );
}
