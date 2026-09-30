/**
 * BridgeInstallLink — every "install the bridge" call to action outside the
 * operator-only Settings › Devices section goes through this one component.
 *
 * Operator only (F0 containment, 2026-09-29). /settings/devices/install gives
 * the verified platform operator the install wizard, and everyone else only
 * pair-only mode for a computer that already has the bridge. A client who
 * clicked "Install bridge" would land on a page with nothing to install, so
 * for anyone but the operator this renders nothing, and each surface shows a
 * plain line instead. `canInstallBridge` must be the server's verified
 * operator verdict (isPlatformOperator / resolvePlatformOperator, both fail
 * closed); only a real `true` opens it.
 *
 * Pinned by tests/f0-containment.test.ts, which also fails if the install
 * route is linked from any other client-reachable file.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Cloud, Cpu, Download } from "lucide-react";

export const BRIDGE_INSTALL_PATH = "/settings/devices/install";

export function BridgeInstallLink({
  canInstallBridge,
  className,
  children,
}: {
  canInstallBridge: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (canInstallBridge !== true) return null;
  return (
    <Link href={BRIDGE_INSTALL_PATH} className={className}>
      {children}
    </Link>
  );
}

/**
 * The "is my computer connected" banner on /sequences. Offline, the operator
 * reads `offline` plus `operatorHint` and gets the Install bridge button;
 * everyone else reads `offline` plus `clientHint` and no button. The page
 * mounts client components that cannot load in a test process, so the banner
 * lives here, where tests/f0-containment.test.ts renders it.
 */
export function BridgeStatusBanner({
  bridgeOnline,
  canInstallBridge,
  online,
  offline,
  operatorHint,
  clientHint,
}: {
  bridgeOnline: boolean;
  canInstallBridge: boolean;
  /** After "Your computer is connected." */
  online: ReactNode;
  /** After "Computer not connected yet." — true for everyone. */
  offline: ReactNode;
  /** Offline, the operator only: what the install button will fix. */
  operatorHint?: ReactNode;
  /** Offline, everyone else: a plain line in place of the button. */
  clientHint?: ReactNode;
}) {
  const operator = canInstallBridge === true;
  const hint = operator ? operatorHint : clientHint;
  return (
    <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">
      {bridgeOnline ? (
        <Cpu className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
      ) : (
        <Cloud className="w-5 h-5 text-fg-dim shrink-0 mt-0.5" />
      )}
      <div className="flex-1 text-xs leading-relaxed">
        {bridgeOnline ? (
          <>
            <span className="text-status-engaged font-bold">Your computer is connected.</span> {online}
          </>
        ) : (
          <>
            <span className="text-fg-muted font-bold">Computer not connected yet.</span> {offline}
            {hint ? <> {hint}</> : null}
          </>
        )}
      </div>
      {!bridgeOnline && (
        <BridgeInstallLink
          canInstallBridge={operator}
          className="btn-primary inline-flex items-center gap-1.5 text-xs shrink-0"
        >
          <Download className="w-3 h-3" />
          Install bridge
        </BridgeInstallLink>
      )}
    </div>
  );
}
