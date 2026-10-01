/**
 * ActivityActorChips — the Activity log's filter row: All, each current
 * teammate and enabled agent, then a collapsed "Former teammates (N)" group
 * for people deactivated since who still have rows in the window.
 *
 * The live row is built from the feed's `activeActors`, never from the
 * attribution roster (which must keep deactivated people so their old rows
 * stay named): that reuse is how the sales team CC retired on 2026-09-24 kept
 * rendering as current teammates (S1-C1, S5-F07). Sentence case, the Feed's
 * chip style, plain links (?actor=) so the filtered view is a URL.
 *
 * Server component, no hooks.
 */

import Link from "next/link";
import type { ActivityActor } from "@/lib/audit/activity-feed";

const BASE = "/settings/audit-log";

function chipClass(selected: boolean): string {
  return `inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ${
    selected ? "border-hairline bg-active text-fg" : "border-hairline text-fg-muted hover:bg-active-hover hover:text-fg"
  }`;
}

function Chip({ actor, selected }: { actor: ActivityActor; selected: boolean }) {
  return (
    <li>
      <Link
        href={`${BASE}?actor=${encodeURIComponent(actor.key)}`}
        prefetch={false}
        className={chipClass(selected)}
        aria-current={selected ? "true" : undefined}
      >
        {actor.label}
      </Link>
    </li>
  );
}

export function ActivityActorChips({
  active,
  former,
  selectedKey,
  filtering,
}: {
  /** Current members, enabled agents and System. */
  active: readonly ActivityActor[];
  /** Deactivated members with rows in the window. */
  former: readonly ActivityActor[];
  /** The actor the page is filtered to, or null. */
  selectedKey: string | null;
  /** True when any ?actor= filter is set, even one that matched nobody. */
  filtering: boolean;
}) {
  const formerSelected = former.some((actor) => actor.key === selectedKey);
  return (
    <div className="space-y-2">
      <ul aria-label="Team" className="flex flex-wrap gap-1.5">
        <li>
          <Link href={BASE} prefetch={false} className={chipClass(!filtering)} aria-current={!filtering ? "true" : undefined}>
            All
          </Link>
        </li>
        {active.map((actor) => (
          <Chip key={actor.key} actor={actor} selected={actor.key === selectedKey} />
        ))}
      </ul>
      {former.length > 0 && (
        <details open={formerSelected || undefined} className="text-[13px] leading-5">
          <summary className="cursor-pointer text-fg-muted">
            Former teammates ({former.length})
          </summary>
          <ul aria-label="Former teammates" className="mt-1.5 flex flex-wrap gap-1.5">
            {former.map((actor) => (
              <Chip key={actor.key} actor={actor} selected={actor.key === selectedKey} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
