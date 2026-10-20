/**
 * Pin an element at its current height until the returned function is called.
 *
 * For content that changes size and then comes back (AcronymMark collapses
 * to "O A S I S" and unfolds again): holding the height keeps everything
 * below it still, so the animation is not counted as layout shift. Reads
 * layout once, when called. Releasing twice, or holding nothing, is a no-op.
 */
export function holdHeight(
  el: { offsetHeight: number; style: { minHeight: string } } | null | undefined,
): () => void {
  if (!el) return () => {};
  const before = el.style.minHeight;
  el.style.minHeight = `${el.offsetHeight}px`;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    el.style.minHeight = before;
  };
}
