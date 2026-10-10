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
import { bridgeConnectionHeadline } from "@/lib/bridge-online-copy";

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
 *
 * `bridgeOnline` is null when the heartbeat could not be read (getBridgeOnline
 * throws, 2026-09-29): "Couldn't check your computer", with no install button,
 * never "Computer not connected yet".
 *
 * `onlineLabels` (2026-10-10): the NAMED online pairings (lib/queries.ts
 * getOnlineBridgeComputerLabels), so the online headline can say which
 * computer(s) are actually paired instead of asserting singular ownership
 * of "your" one — true only for whoever's machine is actually paired,
 * false for every other owner in a shared workspace. Optional for backward
 * compatibility: a caller that has not been migrated still gets an honest,
 * ownership-free headline off `bridgeOnline` alone.
 */
export function BridgeStatusBanner({
  bridgeOnline,
  onlineLabels,
  canInstallBridge,
  online,
  offline,
  operatorHint,
  clientHint,
}: {
  bridgeOnline: boolean | null;
  /** The named online pairings. Omit only from an unmigrated caller. */
  onlineLabels?: string[] | null;
  canInstallBridge: boolean;
  /** After the connection headline, when online. */
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
  // Full naming once the caller passes labels; otherwise an honest fallback
  // that never claims "your" computer (/sequences passes labels — see
  // app/sequences/page.tsx).
  const headline =
    onlineLabels !== undefined
      ? bridgeConnectionHeadline(onlineLabels)
      : bridgeOnline === null
        ? "Couldn't check your computer."
        : bridgeOnline
          ? "A computer is connected."
          : "Computer not connected yet.";
  return (
    <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">
      {bridgeOnline ? (
        <Cpu className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
      ) : (
        <Cloud className="w-5 h-5 text-fg-dim shrink-0 mt-0.5" />
      )}
      <div className="flex-1 text-xs leading-relaxed">
        {bridgeOnline === null ? (
          <>
            <span className="text-fg-muted font-bold">{headline}</span> The connection could
            not be read just now, so this is not saying it is disconnected. Reload in a minute.
          </>
        ) : bridgeOnline ? (
          <>
            <span className="text-status-engaged font-bold">{headline}</span> {online}
          </>
        ) : (
          <>
            <span className="text-fg-muted font-bold">{headline}</span> {offline}
            {hint ? <> {hint}</> : null}
          </>
        )}
      </div>
      {bridgeOnline === false && (
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
