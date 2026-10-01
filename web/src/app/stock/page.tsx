"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import type { Trade } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { Feed } from "@/components/Feed";
import { PostComposer } from "@/components/PostComposer";
import { PriceChart } from "@/components/PriceChart";
import { TradePanel } from "@/components/TradePanel";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { changeClass, gbp, pct, shares } from "@/lib/format";

export default function StockPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <StockView />
    </Suspense>
  );
}

function StockView() {
  const id = useSearchParams().get("id") ?? "";
  const { stockById, holdings, playerById, me } = useGame();
  const stock = stockById.get(id);

  const history = useQuery<Trade>(
    id ? query(collection(fb().db, "trades"), where("stockId", "==", id), orderBy("createdAt", "desc"), limit(300)) : null,
    [id],
  );

  const points = useMemo(() => {
    if (!stock) return [];
    const trades = [...history.data].reverse();
    const pts = trades.map((t) => ({ t: t.createdAt, p: t.priceAfter }));
    // Start from the listing price if we have the full history.
    if (history.data.length < 300) pts.unshift({ t: stock.listedAt, p: stock.listPrice });
    pts.push({ t: Date.now(), p: stock.price });
    return pts;
  }, [history.data, stock]);

  if (!stock) return <p className="muted">Stock not found.</p>;

  const change = stock.weekOpenPrice > 0 ? stock.price / stock.weekOpenPrice - 1 : 0;
  const holders = holdings
    .filter((h) => h.stockId === id && h.shares > 0)
    .sort((a, b) => b.shares - a.shares);
  const heldTotal = holders.reduce((a, h) => a + h.shares, 0);
  const owner = playerById.get(stock.ownerId);

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h1>
            {stock.displayName}
            {owner?.isIdle && <span className="muted small"> · idle</span>}
            {!stock.listed && <span className="muted small"> · delisted</span>}
          </h1>
          <p className="big">
            {gbp(stock.price)} <span className={changeClass(change)}>{pct(change)} this week</span>
          </p>
        </div>
        <dl className="facts small">
          <dt>Week open / high / low</dt>
          <dd>{gbp(stock.weekOpenPrice)} / {gbp(stock.weekHigh)} / {gbp(stock.weekLow)}</dd>
          <dt>Listed at</dt>
          <dd>{gbp(stock.listPrice)} (week {stock.listedWeek})</dd>
          <dt>Pool depth</dt>
          <dd>{gbp(stock.poolCash)} · {shares(stock.poolShares)} shares</dd>
        </dl>
      </div>

      <div className="grid-2">
        <div className="card">
          <PriceChart points={points} label={`${stock.displayName} price history`} />
        </div>
        <TradePanel stock={stock} />
      </div>

      <section className="card">
        <h2>Holders</h2>
        {holders.length === 0 ? (
          <p className="muted">Nobody holds {stock.displayName} yet.</p>
        ) : (
          <ul className="plain">
            {holders.map((h) => (
              <li key={h.uid} className="row between">
                <span>
                  {playerById.get(h.uid)?.displayName ?? "Unknown"}
                  {h.uid === me?.uid && " (you)"}
                </span>
                <span className="muted">
                  {shares(h.shares)} · {gbp(h.shares * stock.price)} · {((h.shares / heldTotal) * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stack">
        <h2>Talk about {stock.id === me?.uid ? "yourself" : stock.displayName}</h2>
        <PostComposer defaultTag={stock.id} />
        <Feed stockId={stock.id} pageSize={30} />
      </section>
    </div>
  );
}
