"use client";

import { Suspense, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import type { Trade } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { Feed } from "@/components/Feed";
import { PostComposer } from "@/components/PostComposer";
import { PriceChart } from "@/components/PriceChart";
import { TradePanel } from "@/components/TradePanel";
import { ShortPanel } from "@/components/ShortPanel";
import { Avatar } from "@/components/Avatar";
import { PhotoEditor } from "@/components/PhotoEditor";
import { TickerEditor } from "@/components/TickerEditor";
import { AlertPanel } from "@/components/AlertPanel";
import { PlayerProfile } from "@/components/PlayerProfile";
import { DonutChart } from "@/components/DonutChart";
import { api, errorMessage } from "@/lib/api";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { changeClass, gbp, pct, profileHref, shares, stockHref } from "@/lib/format";

export default function StockPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <StockView />
    </Suspense>
  );
}

type Tab = "stock" | "player";

function StockView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id") ?? "";
  const tab: Tab = params.get("tab") === "player" ? "player" : "stock";
  const { stockById, holdings, playerById, me, isAdmin, photoOf, tickerOf } = useGame();
  const tabsRef = useRef<HTMLDivElement>(null);
  function selectTab(next: Tab, focus = false) {
    router.replace(next === "player" ? profileHref(id) : stockHref(id), { scroll: false });
    if (focus) requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>(`#tab-${next}`)?.focus());
  }
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      selectTab(e.key === "Home" ? "stock" : e.key === "End" ? "player" : tab === "stock" ? "player" : "stock", true);
    }
  }
  const stock = stockById.get(id);
  const [photoError, setPhotoError] = useState<string | null>(null);

  async function removePhoto() {
    if (!stock || !window.confirm(`Remove ${stock.displayName}'s photo? This is audit-logged.`)) return;
    setPhotoError(null);
    try {
      await api.setStockPhoto(null, stock.id);
    } catch (err) {
      setPhotoError(errorMessage(err));
    }
  }

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
        <div className="row">
          <Avatar uid={stock.id} name={stock.displayName} size={72} />
          <div>
            <h1>
              {stock.displayName} <span className="ticker-chip">${tickerOf(stock.id)}</span>
              {owner?.isIdle && <span className="muted small"> · idle</span>}
              {!stock.listed && <span className="muted small"> · delisted</span>}
            </h1>
            <p className="big">
              {gbp(stock.price)} <span className={changeClass(change)}>{pct(change)} this week</span>
            </p>
            {isAdmin && stock.id !== me?.uid && photoOf(stock.id) && (
              <button type="button" className="link danger small" onClick={removePhoto}>Remove photo (admin)</button>
            )}
            {photoError && <p className="error small" role="alert">{photoError}</p>}
          </div>
        </div>
        <dl className="facts small">
          <dt>Week open / high / low</dt>
          <dd>{gbp(stock.weekOpenPrice)} / {gbp(stock.weekHigh)} / {gbp(stock.weekLow)}</dd>
          <dt>Listed at</dt>
          <dd>{gbp(stock.listPrice)} (week {stock.listedWeek})</dd>
          <dt>Pool depth</dt>
          <dd>{gbp(stock.poolCash)} · {shares(stock.poolShares)} shares</dd>
          {stock.allTimeHigh !== undefined && stock.allTimeLow !== undefined && (
            <>
              <dt>All-time high / low</dt>
              <dd>{gbp(stock.allTimeHigh)} / {gbp(stock.allTimeLow)}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="tabs" role="tablist" aria-label={`${stock.displayName}`} ref={tabsRef} onKeyDown={onTabKey}>
        {(["stock", "player"] as const).map((t) => (
          <button
            key={t}
            id={`tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => selectTab(t)}
          >
            {t === "stock" ? "Stock" : stock.id === me?.uid ? "You" : "Player"}
          </button>
        ))}
      </div>

      {tab === "player" ? (
        <div id="panel-player" role="tabpanel" aria-labelledby="tab-player">
          <PlayerProfile uid={stock.id} />
        </div>
      ) : (
      <div id="panel-stock" role="tabpanel" aria-labelledby="tab-stock" className="stack">
      <div className="grid-2">
        <div className="card">
          <PriceChart points={points} label={`${stock.displayName} price history`} />
        </div>
        <TradePanel stock={stock} />
      </div>

      {stock.listed && stock.ownerId !== me?.uid && <ShortPanel stock={stock} />}

      <AlertPanel stock={stock} />

      {stock.id === me?.uid && stock.listed && (
        <section className="card stack">
          <h2>Your stock</h2>
          <TickerEditor stock={stock} />
          <PhotoEditor />
        </section>
      )}

      <section className="card">
        <h2>Holders</h2>
        {holders.length === 0 ? (
          <p className="muted">Nobody holds {stock.displayName} yet.</p>
        ) : holders.length > 1 ? (
          <DonutChart
            label={`Who owns ${stock.displayName}`}
            centreLabel="Held by players"
            slices={holders.map((h) => ({
              id: h.uid,
              label: `${playerById.get(h.uid)?.displayName ?? "Unknown"}${h.uid === me?.uid ? " (you)" : ""}`,
              value: h.shares * stock.price,
            }))}
          />
        ) : (
          <ul className="plain">
            {holders.map((h) => (
              <li key={h.uid} className="row between">
                <span className="with-avatar">
                  <Avatar uid={h.uid} name={playerById.get(h.uid)?.displayName ?? "?"} size={24} />
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
        <Feed stockId={stock.id} pageSize={10} />
      </section>
      </div>
      )}
    </div>
  );
}
