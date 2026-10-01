"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { REACTION_EMOJI, REACTION_TYPES, type Post, type ReactionType, type Trade } from "@fsm/shared";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { api, errorMessage } from "@/lib/api";
import { ago, changeClass, gbp, pct, shares, stockHref } from "@/lib/format";
import { useGame } from "./GameProvider";
import { PostComposer } from "./PostComposer";

type Item = { kind: "trade"; at: number; trade: Trade } | { kind: "post"; at: number; post: Post };

/** One chronological feed of trades and posts (§7). Optionally scoped to one stock. */
export function Feed({ stockId, pageSize = 60 }: { stockId?: string; pageSize?: number }) {
  const db = fb().db;
  const [size, setSize] = useState(pageSize);
  const tradesQ = useQuery<Trade>(
    stockId
      ? query(collection(db, "trades"), where("stockId", "==", stockId), orderBy("createdAt", "desc"), limit(size))
      : query(collection(db, "trades"), orderBy("createdAt", "desc"), limit(size)),
    [stockId, size],
  );
  const postsQ = useQuery<Post>(
    stockId
      ? query(collection(db, "posts"), where("taggedStockId", "==", stockId), orderBy("createdAt", "desc"), limit(size))
      : query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(size)),
    [stockId, size],
  );

  const items = useMemo<Item[]>(() => {
    const postIds = new Set(postsQ.data.map((p) => p.id));
    const list: Item[] = [
      ...postsQ.data.map((post) => ({ kind: "post" as const, at: post.createdAt, post })),
      // A trade with a linked post is shown via the post itself.
      ...tradesQ.data
        .filter((t) => !(t.linkedPostId && postIds.has(t.linkedPostId)))
        .map((trade) => ({ kind: "trade" as const, at: trade.createdAt, trade })),
    ];
    return list.sort((a, b) => b.at - a.at);
  }, [postsQ.data, tradesQ.data]);

  const error = tradesQ.error ?? postsQ.error;
  const hasMore = tradesQ.data.length >= size || postsQ.data.length >= size;

  return (
    <section aria-label="Feed" className="feed">
      {error && <p className="error" role="alert">Couldn&apos;t load the feed: {error.message}</p>}
      {!tradesQ.loading && !postsQ.loading && items.length === 0 && <p className="muted">Nothing here yet.</p>}
      <ul className="feed-list">
        {items.map((it) =>
          it.kind === "trade" ? (
            <li key={`t-${it.trade.id}`}><TradeItem trade={it.trade} /></li>
          ) : (
            <li key={`p-${it.post.id}`}><PostItem post={it.post} /></li>
          ),
        )}
      </ul>
      {hasMore && (
        <button type="button" onClick={() => setSize((s) => s + pageSize)}>Load more</button>
      )}
    </section>
  );
}

function TradeItem({ trade }: { trade: Trade }) {
  const { me } = useGame();
  const [annotating, setAnnotating] = useState(false);
  const move = trade.priceAfter / trade.priceBefore - 1;
  const mine = me?.uid === trade.traderId;
  return (
    <article className="item trade">
      <div className="item-head">
        <span className={`badge ${trade.side}`}>{trade.side === "buy" ? "BUY" : "SELL"}</span>
        <span>
          <strong>{trade.traderName}</strong> {trade.side === "buy" ? "bought" : "sold"} {shares(trade.shares)} shares of{" "}
          <Link href={stockHref(trade.stockId)}>{trade.stockName}</Link> for {gbp(trade.cashAmount)}
        </span>
        <time className="muted small" dateTime={new Date(trade.createdAt).toISOString()}>{ago(trade.createdAt)}</time>
      </div>
      <div className="small muted">
        {gbp(trade.priceBefore)} → {gbp(trade.priceAfter)} <span className={changeClass(move)}>{pct(move)}</span>
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
        <strong>{post.authorName}</strong>
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
            const active = me ? list.includes(me.uid) : false;
            return (
              <button
                key={r}
                type="button"
                className={`reaction${active ? " active" : ""}`}
                aria-pressed={active}
                aria-label={`${r} (${list.length})`}
                disabled={!me?.isActive}
                onClick={() => react(r)}
              >
                {REACTION_EMOJI[r]} {list.length > 0 ? list.length : ""}
              </button>
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
