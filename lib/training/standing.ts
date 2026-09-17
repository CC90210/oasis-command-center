/**
 * What a rep's stored progress means against the CURRENT curriculum.
 *
 * WHY THIS EXISTS. On 2026-09-17 the item bank was rewritten and every item id
 * changed. The hub counted stored progress rows by section and sized the
 * denominator from the live curriculum, so a rep who had practised the old
 * items would have been shown something like "7 of 4 known" in a section that
 * now holds four. Worse, a stored section completion still lit the Finished
 * badge on a section whose questions they had never seen.
 *
 * Found by the independent review on commit 2bcf0f8f, and it is the kind of
 * defect that reads as normal: nobody looking at the page would know the
 * numerator and the denominator came from different curricula.
 *
 * THE RULE: stored history is kept, but only the part of it that refers to
 * something a rep can actually be asked today is counted. A row for a removed
 * item stays in the table, because a rep's history is worth keeping, and
 * contributes nothing to a number on screen.
 *
 * PURE, so it can be tested without a database. The read side lives in
 * `lib/training/progress.ts`.
 *
 * 🚨 SUPERSEDED BY PHASE 3. This defines "known" as answered right at least
 * once, which is not mastery. The research is unambiguous that mastery takes
 * three correct recalls across three SEPARATE sessions, and one correct in each
 * of three sessions beats three in one session by more than double (Rawson &
 * Dunlosky 2022). The scheduler replaces this definition; until it lands, this
 * is honest about being a coverage count rather than a mastery bar.
 */

export type StoredProgressRow = {
  itemId: string;
  sectionSlug: string;
  rightCount: number;
};

export type SectionStanding = {
  /** Current items this rep has answered right at least once. */
  known: number;
  /** Items the section holds today. */
  total: number;
  finished: boolean;
};

/**
 * Per-section standing, counting only what the curriculum still contains.
 *
 * `finished` requires BOTH a stored completion AND coverage of every current
 * item. A completion row cannot say which curriculum it was earned against,
 * because nothing records that, so coverage is the available proxy. It fails
 * in the safe direction: a rewritten section stops being Finished until the
 * rep has actually met its new questions.
 */
export function sectionStandings(args: {
  items: readonly { id: string; section: string }[];
  progress: readonly StoredProgressRow[];
  completedSlugs: ReadonlySet<string>;
}): Map<string, SectionStanding> {
  const { items, progress, completedSlugs } = args;

  const liveIds = new Set(items.map((i) => i.id));
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.section, (totals.get(item.section) ?? 0) + 1);

  // Counted per ITEM, not per row, so a duplicated row cannot inflate the
  // numerator past the denominator.
  const knownIds = new Map<string, Set<string>>();
  for (const row of progress) {
    if (row.rightCount <= 0) continue;
    if (!liveIds.has(row.itemId)) continue; // history for an item nobody can be asked
    const set = knownIds.get(row.sectionSlug) ?? new Set<string>();
    set.add(row.itemId);
    knownIds.set(row.sectionSlug, set);
  }

  const out = new Map<string, SectionStanding>();
  for (const [section, total] of totals) {
    const known = knownIds.get(section)?.size ?? 0;
    out.set(section, {
      known,
      total,
      finished: completedSlugs.has(section) && total > 0 && known >= total,
    });
  }
  return out;
}

/** Sections the rep has genuinely finished against today's curriculum. */
export function finishedCount(standings: ReadonlyMap<string, SectionStanding>): number {
  let n = 0;
  for (const s of standings.values()) if (s.finished) n++;
  return n;
}
