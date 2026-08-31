"use client";

/**
 * BattleSection — the battle card's own disclosure shell, plus the small bus
 * that lets the card speak to its sections (expand all, collapse all, and
 * "open the faults section and take me to trust").
 *
 * ═══ WHY THE CARD COLLAPSES AT ALL (Adon, 2026-08-31) ═══════════════════════
 *
 * The card originally rendered everything open, on the theory that any click
 * is one a rep will not make with a stranger waiting. Adon reviewed it in use
 * and reversed that: "it's just so much information that's in front of your
 * face." This shell is the resolution that keeps both truths:
 *
 *   - The sections a rep reads WHILE dialing default OPEN. Collapsing is a
 *     choice they make, not a click the card demands mid-call.
 *   - The reference sections default CLOSED behind a one-line teaser that says
 *     exactly what is inside, so a closed section is a labelled drawer and
 *     never a mystery.
 *   - Every choice persists per rep in localStorage, so the card a rep shaped
 *     for themselves is the card they get on the next lead.
 *   - "Expand all" restores the original everything-open page in one click.
 *
 * ═══ WHY NOT components/leads/CollapsibleSection ════════════════════════════
 *
 * That component is the repo's other disclosure shell and this one borrows its
 * patterns wholesale (chevron, aria-expanded, localStorage read in an effect
 * so the server and the first client paint agree). It is not reused directly
 * because it carries the leads-page chrome (its own heading scale, shadow-card,
 * a bordered content well) and the battle card's sections must keep rendering
 * exactly like the Panels they were — same radius, same border, same padding —
 * or the pipeline page shows two section styles on one screen. The pipeline's
 * OUTER "Website battle card" wrapper still IS CollapsibleSection; this shell
 * lives one level down, inside the card.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. NO COLOUR IS KEYED TO A SCORE — this file renders no audit data, which is
 *    exactly why it is on the banned-colour list in web-leads-guards.test.ts
 *    rather than trusted: a "safe" chrome file is where a future editor tints
 *    a header to flag a bad section.
 * 2. Collapse state is CHROME, never content: a section renders the same
 *    children on every surface, or it does not render them. Nothing in here
 *    may branch on `embedded`.
 * 3. Motion respects prefers-reduced-motion via `motion-reduce:`/`motion-safe:`
 *    classes; the chevron and the one-shot content fade are the only things
 *    that move, and both are the rep's own click echoed back.
 *
 * ═══ THE FUTURIST CHROME (Adon, 2026-08-31, round 2) ════════════════════════
 *
 * "Even nicer and 3D, a futuristic look." The shell carries the section half
 * of that system: glass panels (translucent bg + backdrop blur), a lit top
 * edge (the one constant marker of a battle-card section), an accent tick on
 * the title, and pill controls that glow on hover. Every piece is keyed to
 * NOTHING -- it renders identically for a 4 and a 94, open or closed, which is
 * what keeps rule 1 intact on a surface this decorated.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";

type Broadcast = { seq: number; open: boolean } | null;
type Targeted = { seq: number; id: string } | null;

const BattleSectionsContext = createContext<{
  broadcast: Broadcast;
  targeted: Targeted;
  setAll: (open: boolean) => void;
  openOne: (id: string) => void;
} | null>(null);

/** Read by sections (to obey broadcasts) and by anything that wants to open a
 *  sibling section, e.g. the dimension detail's "see all fixes" cross-link. */
export function useBattleSections() {
  return useContext(BattleSectionsContext);
}

export function BattleSections({ children }: { children: ReactNode }) {
  const [broadcast, setBroadcast] = useState<Broadcast>(null);
  const [targeted, setTargeted] = useState<Targeted>(null);
  const value = useMemo(
    () => ({
      broadcast,
      targeted,
      setAll: (open: boolean) => setBroadcast((p) => ({ seq: (p?.seq ?? 0) + 1, open })),
      openOne: (id: string) => setTargeted((p) => ({ seq: (p?.seq ?? 0) + 1, id })),
    }),
    [broadcast, targeted],
  );
  return <BattleSectionsContext.Provider value={value}>{children}</BattleSectionsContext.Provider>;
}

const storageKeyFor = (id: string) => `oasis.battlecard.section.${id}`;

function persist(id: string, open: boolean) {
  try {
    window.localStorage.setItem(storageKeyFor(id), open ? "1" : "0");
  } catch {
    // localStorage blocked — the toggle still works for this session.
  }
}

/** The two whole-card controls. Text, not icons: "Expand all" is an escape
 *  hatch back to the original everything-open page and must read as one. */
export function SectionToolbar() {
  const bus = useBattleSections();
  if (!bus) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-[11px] font-semibold">
      <button
        type="button"
        onClick={() => bus.setAll(true)}
        className="rounded-full border border-bg-border px-3 py-1 text-fg-dim transition-[color,border-color,box-shadow] hover:border-accent/40 hover:text-fg hover:shadow-glow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
      >
        Expand all
      </button>
      <button
        type="button"
        onClick={() => bus.setAll(false)}
        className="rounded-full border border-bg-border px-3 py-1 text-fg-dim transition-[color,border-color,box-shadow] hover:border-accent/40 hover:text-fg hover:shadow-glow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
      >
        Collapse all
      </button>
    </div>
  );
}

export function BattleSection({
  id,
  defaultOpen,
  title,
  sub,
  teaser,
  children,
}: {
  id: string;
  defaultOpen: boolean;
  title: string;
  /** Shown under the title while OPEN — the section's own explanatory line. */
  sub?: ReactNode;
  /** Shown under the title while CLOSED — one line saying what is inside, so
   *  a closed section is a labelled drawer, never a mystery. */
  teaser?: ReactNode;
  children: ReactNode;
}) {
  const bus = useBattleSections();
  // null until the effect reads localStorage, so the server and the first
  // client paint agree on defaultOpen — same hydration argument as
  // useReducedMotion in BattleCard.tsx.
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKeyFor(id));
      if (raw === "0") setOpen(false);
      else if (raw === "1") setOpen(true);
    } catch {
      // stays null → defaultOpen
    }
  }, [id]);

  // Expand all / collapse all. Persisted: a rep who collapsed everything
  // should not find it all open again on the next lead.
  const broadcast = bus?.broadcast ?? null;
  useEffect(() => {
    if (!broadcast) return;
    setOpen(broadcast.open);
    persist(id, broadcast.open);
  }, [broadcast, id]);

  // A targeted open (cross-link from another section). NOT persisted: being
  // sent somewhere once is navigation, not a preference.
  const targeted = bus?.targeted ?? null;
  useEffect(() => {
    if (!targeted || targeted.id !== id) return;
    setOpen(true);
  }, [targeted, id]);

  const isOpen = open ?? defaultOpen;

  function toggle() {
    const next = !isOpen;
    setOpen(next);
    persist(id, next);
  }

  return (
    <section className="relative overflow-hidden rounded-xl border border-bg-border bg-bg-panel/75 shadow-card backdrop-blur-sm transition-shadow hover:shadow-elev motion-reduce:transition-none">
      {/* The lit top edge -- the one constant marker of a battle-card section.
          Keyed to nothing: identical for a 4 and a 94, open or closed. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent"
      />
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={`battle-section-${id}`}
        className="group flex w-full items-start justify-between gap-4 rounded-xl px-5 py-4 text-left transition-colors hover:bg-bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none lg:px-6"
      >
        <span className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted transition-colors group-hover:text-fg motion-reduce:transition-none">
            <span aria-hidden className="h-3 w-[3px] shrink-0 rounded-full bg-accent/70 shadow-glow" />
            {title}
          </h2>
          {isOpen
            ? sub != null && <span className="mt-1 block max-w-4xl pl-[11px] text-xs leading-relaxed text-fg-dim">{sub}</span>
            : teaser != null && <span className="mt-1 block truncate pl-[11px] text-xs text-fg-dim">{teaser}</span>}
        </span>
        <ChevronDown
          aria-hidden
          className={`mt-0.5 h-4 w-4 shrink-0 text-fg-dim transition-transform duration-200 motion-reduce:transition-none ${isOpen ? "" : "-rotate-90"}`}
        />
      </button>
      {isOpen && (
        <div id={`battle-section-${id}`} className="px-5 pb-5 motion-safe:animate-fade-in lg:px-6 lg:pb-6">
          {children}
        </div>
      )}
    </section>
  );
}

export default BattleSection;
