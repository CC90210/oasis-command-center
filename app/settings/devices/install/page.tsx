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
import { ArrowLeft, Cloud, Cpu, Info } from "lucide-react";
import { PageHeader } from "@/components/Card";
import { getSessionUser } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { isAgentsOwner } from "@/lib/agents-owner";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
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
  const profile = await safe("devices.install.profile", getActiveProfile(), null);
  const [op, agentsOwner] = await Promise.all([
    resolvePlatformOperator(),
    // O1: the full install clones this workspace's own private harness repo,
    // readable only by its AGENTS OWNER (lib/agents-owner.ts). Since PR #576
    // every OASIS founder is a verified operator, which is no longer enough
    // on its own: the 2026-10-11 incident is exactly a non-owner operator
    // (Adon) running this command and hitting a 404 on the private repo.
    profile?.tenant_id && profile?.auth_user_id
      ? safe("devices.install.agents_owner", isAgentsOwner(profile.tenant_id, profile.auth_user_id), false)
      : Promise.resolve(false),
  ]);
  // Both must hold: the private repo stays OASIS-operator-only AND
  // owner-only, so a future client workspace's agents owner (a row any
  // operator may hand-insert for a non-OASIS tenant, O1) never sees it either.
  const canFullInstall = op.operator && agentsOwner;

  const back = (
    <Link
      href={op.operator ? setupHref("bridge_devices") : setupHref("profile")}
      className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
    >
      <ArrowLeft className="w-3 h-3" /> Back to Settings
    </Link>
  );

  if (!canFullInstall) {
    // A verified operator who is not this workspace's computer owner (Adon)
    // gets the plain, honest notice: pairing a computer of his own cannot
    // reach anywhere useful yet (O1 routes every department chat to the
    // owner's computer alone), so neither the full install nor the generic
    // pair-only flow belongs on his screen. Everyone else signed in (a
    // teammate, a client workspace owner) keeps today's pair-only page,
    // which works for them: their own tenant has no computer-owner lock.
    if (op.operator) {
      return (
        <div className="space-y-6 animate-fade-in">
          <PageHeader title="Connect a computer" action={back} />
          <OwnerOnlyInstallNotice />
        </div>
      );
    }
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

/**
 * A verified operator who is not this workspace's computer owner (DV0,
 * 2026-10-11). Plain words only: what connecting a computer would do, that it
 * runs through the OASIS connector app, that nothing needs installing today,
 * and that department chats pause for the same reason they already do in
 * chat (O1: every department chat runs on the owner's computer alone). Never
 * the private repository's name, never a button that cannot work.
 *
 * Updated (DV1), matching components/settings/DevicesEditor.tsx's
 * OwnerOnlyConnectNotice: the connector program's server side (O3a) is live,
 * the installer that would make this notice obsolete is J2 and not shipped
 * yet, so this points the viewer at the one place every signed-in person
 * (this one included) can already get a connector code: Settings > Connect
 * your computer.
 */
function OwnerOnlyInstallNotice() {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Info className="w-4 h-4 text-fg-dim" aria-hidden="true" />
        <h2 className="text-base font-bold text-fg">Connecting your own computer</h2>
      </div>
      <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
        Connecting your own computer would let your agents use its files,
        tools and scheduled jobs. That runs through the OASIS connector app,
        which is rolling out. If you already have it, paste a connector code
        into it, get one from Settings &gt; Connect your computer. If you do
        not have it yet, there is nothing to install today. Until a computer
        is connected and approved, your department chats pause instead of
        running on someone else&apos;s computer.
      </p>
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
