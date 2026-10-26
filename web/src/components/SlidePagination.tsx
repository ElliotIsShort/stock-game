"use client";

import { useSlideIndicator } from "@/lib/hooks";
import { pageRange } from "@/lib/pagination";

/**
 * Page buttons with an active indicator that slides between pages (after
 * easyui's slide-pagination). `hasMore` shows a trailing ellipsis when there
 * are older pages that haven't been counted yet.
 */
export function SlidePagination({
  pageCount,
  page,
  onChange,
  siblingCount = 1,
  hasMore = false,
  label = "Pagination",
}: {
  pageCount: number;
  page: number;
  onChange: (page: number) => void;
  siblingCount?: number;
  hasMore?: boolean;
  label?: string;
}) {
  const pages = pageRange(pageCount, page, siblingCount);
  const { ref, box } = useSlideIndicator<HTMLUListElement>('[aria-current="page"]', [page, pages.join(",")]);
  const go = (p: number) => onChange(Math.min(Math.max(1, p), pageCount));

  return (
    <nav aria-label={label} className="pager">
      <button type="button" className="pager-step" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}>
        <Chevron dir="left" />
      </button>
      <ul ref={ref}>
        {box && (
          <li
            className={`slide-indicator${box.animate ? " animate" : ""}`}
            aria-hidden="true"
            style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}
          />
        )}
        {pages.map((p, i) =>
          p === "…" ? (
            <li key={`gap-${i}`} className="pager-gap" aria-hidden="true">…</li>
          ) : (
            <li key={p}>
              <button type="button" aria-current={p === page ? "page" : undefined} aria-label={`Page ${p}`} onClick={() => go(p)}>
                {p}
              </button>
            </li>
          ),
        )}
        {hasMore && <li className="pager-gap" aria-hidden="true">…</li>}
      </ul>
      <button type="button" className="pager-step" aria-label="Next page" disabled={page >= pageCount} onClick={() => go(page + 1)}>
        <Chevron dir="right" />
      </button>
    </nav>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}
