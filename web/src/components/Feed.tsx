"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { REACTION_EMOJI, REACTION_TYPES, type Post, type ReactionType, type Trade } from "@fsm/shared";
import { fb } from "@/lib/firebase";
import { prefersReducedMotion, useMediaQuery, useQuery } from "@/lib/hooks";
import { api, errorMessage } from "@/lib/api";
import { ago, changeClass, gbp, pct, profileHref, shares, signedGbp, stockHref } from "@/lib/format";
import { Sparkline } from "./StatCard";
import { playSound } from "@/lib/sound";
import { feedCutoff } from "@/lib/pagination";
import { Avatar } from "./Avatar";
import { useGame } from "./GameProvider";
import { PostComposer } from "./PostComposer";
import { SlidePagination } from "./SlidePagination";

type Item = { kind: "trade"; at: number; trade: Trade } | { kind: "post"; at: number; post: Post };

/** One chronological feed of trades and posts (§7), paginated. Optionally scoped to one stock. */
export function Feed({ stockId, pageSize = 15 }: { stockId?: string; pageSize?: number }) {
  // Remount per stock so page and query limits reset when you switch stocks.
  return <PagedFeed key={stockId ?? "all"} stockId={stockId} pageSize={pageSize} />;
}

/**
 * Trades and posts are two newest-first queries merged on the client. Each
 * query loads enough for the current page plus one page of lookahead, so we
 * always know whether a next page exists without counting the collections.
 * Limits only ever grow, so flipping back to earlier pages costs no re-reads.
 */
function PagedFeed({ stockId, pageSize }: { stockId?: string; pageSize: number }) {
  const db = fb().db;
  const [page, setPage] = useState(1);
  const want = (page + 1) * pageSize;
  const [tradeLimit, setTradeLimit] = useState(want);
  const [postLimit, setPostLimit] = useState(want);
  useEffect(() => {
    setTradeLimit((l) => Math.max(l, want));
    setPostLimit((l) => Math.max(l, want));
  }, [want]);

  const tradesQ = useQuery<Trade>(
    stockId
      ? query(collection(db, "trades"), where("stockId", "==", stockId), orderBy("createdAt", "desc"), limit(tradeLimit))
      : query(collection(db, "trades"), orderBy("createdAt", "desc"), limit(tradeLimit)),
    [stockId, tradeLimit],
  );
  const postsQ = useQuery<Post>(
    stockId
      ? query(collection(db, "posts"), where("taggedStockId", "==", stockId), orderBy("createdAt", "desc"), limit(postLimit))
      : query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(postLimit)),
    [stockId, postLimit],
  );

  // Compare against the limit each snapshot was fetched with, not a limit we've just raised but not loaded yet.
  const tradesFetchedWith = useFetchedLimit(tradesQ.data, tradeLimit);
  const postsFetchedWith = useFetchedLimit(postsQ.data, postLimit);
  // A query that hasn't returned anything yet holds the whole feed back (cutoff = ∞).
  const tradesTruncated = (tradesQ.loading && tradesQ.data.length === 0) || tradesQ.data.length >= tradesFetchedWith;
  const postsTruncated = (postsQ.loading && postsQ.data.length === 0) || postsQ.data.length >= postsFetchedWith;
  const { cutoff, limiting } = feedCutoff([
    { oldest: tradesQ.data.at(-1)?.createdAt ?? null, truncated: tradesTruncated },
    { oldest: postsQ.data.at(-1)?.createdAt ?? null, truncated: postsTruncated },
  ]);

  // Only the prefix newer than the cutoff is complete; older items may be missing from a truncated query.
  const items = useMemo<Item[]>(() => {
    const postIds = new Set(postsQ.data.map((p) => p.id));
    const list: Item[] = [
      ...postsQ.data.map((post) => ({ kind: "post" as const, at: post.createdAt, post })),
      // A trade with a linked post is shown via the post itself.
      ...tradesQ.data
        .filter((t) => !(t.linkedPostId && postIds.has(t.linkedPostId)))
        .map((trade) => ({ kind: "trade" as const, at: trade.createdAt, trade })),
    ];
    return list.filter((it) => it.at >= cutoff).sort((a, b) => b.at - a.at);
  }, [postsQ.data, tradesQ.data, cutoff]);

  // Not enough complete items for this page + lookahead: extend whichever query is holding the cutoff back.
  const loading = tradesQ.loading || postsQ.loading;
  useEffect(() => {
    if (loading || items.length >= want || limiting === null) return;
    if (limiting === 0) setTradeLimit((l) => l + pageSize);
    else setPostLimit((l) => l + pageSize);
  }, [loading, items.length, want, limiting, pageSize]);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const hasMore = tradesTruncated || postsTruncated;
  const current = Math.min(page, pageCount);
  const visible = items.slice((current - 1) * pageSize, current * pageSize);

  // If items disappear (e.g. a post is deleted) and this page no longer exists, step back.
  useEffect(() => {
    if (!loading && page > pageCount) setPage(pageCount);
  }, [loading, page, pageCount]);

  const sectionRef = useRef<HTMLElement>(null);
  const narrow = useMediaQuery("(max-width: 480px)");
  function changePage(next: number) {
    setPage(next);
    const el = sectionRef.current;
    // Bring the top of the feed back into view if you've scrolled past it (or it's under the sticky top bar + strip).
    if (el && el.getBoundingClientRect().top < 100) el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  const error = tradesQ.error ?? postsQ.error;

  return (
    <section aria-label="Feed" className="feed" ref={sectionRef}>
      {error && <p className="error" role="alert">Couldn&apos;t load the feed: {error.message}</p>}
      {!loading && items.length === 0 && !hasMore && <p className="muted">Nothing here yet.</p>}
      <ul className="feed-list">
        {visible.map((it) =>
          it.kind === "trade" ? (
            <li key={`t-${it.trade.id}`}><TradeItem trade={it.trade} /></li>
          ) : (
            <li key={`p-${it.post.id}`}><PostItem post={it.post} /></li>
          ),
        )}
      </ul>
      {pageCount > 1 && (
        <div className="feed-pager">
          <SlidePagination
            label="Feed pages"
            pageCount={pageCount}
            page={current}
            onChange={changePage}
            hasMore={hasMore}
            siblingCount={narrow ? 0 : 1}
          />
        </div>
      )}
    </section>
  );
}

/** The query limit that was in force when this snapshot of `data` arrived. */
function useFetchedLimit<T>(data: T[], limitNow: number): number {
  const ref = useRef({ data, limit: limitNow });
  if (ref.current.data !== data) ref.current = { data, limit: limitNow };
  return ref.current.limit;
}

function TradeItem({ trade }: { trade: Trade }) {
  const { me, tickerOf } = useGame();
  const [annotating, setAnnotating] = useState(false);
  const move = trade.priceAfter / trade.priceBefore - 1;
  const mine = me?.uid === trade.traderId;
  const isShort = trade.kind === "openShort" || trade.kind === "closeShort";
  const badge = trade.kind === "openShort" ? "SHORT" : trade.kind === "closeShort" ? "COVER" : trade.side === "buy" ? "BUY" : "SELL";
  const verb =
    trade.kind === "openShort" ? "opened a short on" : trade.kind === "closeShort" ? "closed a short on" : trade.side === "buy" ? "bought" : "sold";
  return (
    <article className="item trade">
      <div className="item-head">
        <span className={`badge ${isShort ? "short" : trade.side}`}>{badge}</span>
        <span>
          <Link href={profileHref(trade.traderId)} className="strong-link">{trade.traderName}</Link> {verb} {shares(trade.shares)} shares of{" "}
          <Link href={stockHref(trade.stockId)}>{trade.stockName}</Link>{trade.kind === "openShort" ? "" : ` for ${gbp(trade.cashAmount)}`}
        </span>
        <time className="muted small" dateTime={new Date(trade.createdAt).toISOString()}>{ago(trade.createdAt)}</time>
      </div>
      <div className="small muted trade-move">
        <span className="ticker-chip">${tickerOf(trade.stockId)}</span>
        <span>{gbp(trade.priceBefore)} → {gbp(trade.priceAfter)}</span>
        <span className={`delta ${changeClass(move)}`}>
          <span aria-hidden="true">{move > 0.00005 ? "▲" : move < -0.00005 ? "▼" : "■"}</span> {signedGbp(trade.priceAfter - trade.priceBefore)} ({pct(move)})
        </span>
        {/* Recent prices up to this trade (stored on the trade). Older trades don't have them. */}
        {trade.recentPrices && trade.recentPrices.length >= 3 && <Sparkline values={trade.recentPrices} className="trade-spark" />}
      </div>
      {mine && !trade.linkedPostId && (
        annotating ? (
          <PostComposer linkedTradeId={trade.id} onDone={() => setAnnotating(false)} compact />
        ) : (
          <button type="button" className="link small" onClick={() => setAnnotating(true)}>Say why…</button>
        )
      )}
    </article>
  );
}

/**
 * A reaction chip. Your own tap makes the emoji bounce; any change to the
 * count (yours or someone else's, arriving live) rolls the number in.
 * Both animations are CSS and switch off under prefers-reduced-motion.
 */
function ReactionButton({
  type,
  count,
  active,
  disabled,
  onReact,
}: {
  type: ReactionType;
  count: number;
  active: boolean;
  disabled: boolean;
  onReact: () => void;
}) {
  const [bounce, setBounce] = useState(0);
  const prev = useRef(count);
  const dir = count > prev.current ? "up" : count < prev.current ? "down" : null;
  useEffect(() => {
    prev.current = count;
  }, [count]);
  return (
    <button
      type="button"
      className={`reaction${active ? " active" : ""}`}
      aria-pressed={active}
      aria-label={`${type} (${count})`}
      disabled={disabled}
      onClick={() => {
        if (!active) playSound("react");
        setBounce((b) => b + 1);
        onReact();
      }}
    >
      <span key={bounce} className={bounce ? "reaction-emoji bounce" : "reaction-emoji"}>{REACTION_EMOJI[type]}</span>
      {count > 0 && (
        <span key={count} className={`reaction-count${dir ? ` roll-${dir}` : ""}`}>{count}</span>
      )}
    </button>
  );
}

function PostItem({ post }: { post: Post }) {
  const { me, isAdmin } = useGame();
  const [error, setError] = useState<string | null>(null);

  async function react(r: ReactionType) {
    setError(null);
    try {
      await api.toggleReaction(post.id, r);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove() {
    const reason = window.prompt("Delete this post? Optionally give a reason for the audit log:", "");
    if (reason === null) return;
    try {
      await api.deletePost(post.id, reason || undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <article className={`item post${post.system ? " system" : ""}`}>
      <div className="item-head">
        {!post.system && <Avatar uid={post.authorId} name={post.authorName} size={24} />}
        {post.system ? <strong>{post.authorName}</strong> : <Link href={profileHref(post.authorId)} className="strong-link">{post.authorName}</Link>}
        {post.taggedStockId && post.taggedName && !post.system && (
          <span className="muted">
            {" "}on <Link href={stockHref(post.taggedStockId)}>{post.taggedName}</Link>
          </span>
        )}
        <time className="muted small" dateTime={new Date(post.createdAt).toISOString()}>{ago(post.createdAt)}</time>
      </div>
      {post.linkedTradeSummary && <div className="linked small">{post.linkedTradeSummary}</div>}
      <p className="post-text">{post.text}</p>
      {!post.system && (
        <div className="reactions" role="group" aria-label="Reactions">
          {REACTION_TYPES.map((r) => {
            const list = post.reactions?.[r] ?? [];
            return (
              <ReactionButton
                key={r}
                type={r}
                count={list.length}
                active={me ? list.includes(me.uid) : false}
                disabled={!me?.isActive}
                onReact={() => react(r)}
              />
            );
          })}
          {isAdmin && (
            <button type="button" className="link danger small" onClick={remove}>Delete</button>
          )}
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </article>
  );
}
