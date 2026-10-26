/** Pure helpers for paginating the merged trades + posts feed. */

export type PageItem = number | "…";

/**
 * Page buttons to show: first, last, the current page and `siblings` either
 * side, with ellipses for the gaps. Always the same length once pageCount is
 * large enough, so the control doesn't jump around as you move.
 */
export function pageRange(pageCount: number, current: number, siblings = 1): PageItem[] {
  const total = siblings * 2 + 5;
  if (pageCount <= total) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const left = Math.max(current - siblings, 1);
  const right = Math.min(current + siblings, pageCount);
  const showLeft = left > 2;
  const showRight = right < pageCount - 1;
  const edge = 3 + siblings * 2;
  if (!showLeft && showRight) return [...Array.from({ length: edge }, (_, i) => i + 1), "…", pageCount];
  if (showLeft && !showRight) return [1, "…", ...Array.from({ length: edge }, (_, i) => pageCount - edge + i + 1)];
  return [1, "…", ...Array.from({ length: siblings * 2 + 1 }, (_, i) => left + i), "…", pageCount];
}

export interface FeedSource<T> {
  /** Newest-first items from one collection. */
  items: T[];
  /** The query limit used. If items.length reaches it, older items may exist. */
  limit: number;
}

/**
 * The feed merges two separately-limited, newest-first queries. Only the
 * prefix newer than the oldest item of any truncated query is guaranteed
 * complete: anything older might be missing from that collection. Returns the
 * cutoff time, and which source (if any) should load more to extend it.
 */
export function feedCutoff(sources: { oldest: number | null; truncated: boolean }[]): { cutoff: number; limiting: number | null } {
  let cutoff = -Infinity;
  let limiting: number | null = null;
  sources.forEach((s, i) => {
    if (!s.truncated) return;
    const oldest = s.oldest ?? Infinity;
    if (oldest > cutoff) {
      cutoff = oldest;
      limiting = i;
    }
  });
  return { cutoff, limiting };
}
