"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { collection, doc, limit, orderBy, query, where } from "firebase/firestore";
import { positionFromTrades, type NetWorthHistory, type Trade } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { PhotoEditor } from "@/components/PhotoEditor";
import { LineChart } from "@/components/LineChart";
import { fb } from "@/lib/firebase";
import { useDoc, useQuery } from "@/lib/hooks";
import { ago, changeClass, gbp, pct, shares, stockHref } from "@/lib/format";

export default function PortfolioPage() {
  const { me, playerById, myHoldings, stockById, holdings, config } = useGame();
  const uid = me?.uid ?? null;
  // All of my trades, oldest-first cost basis needs the full history (not just recent).
  const myTrades = useQuery<Trade>(
    uid ? query(collection(fb().db, "trades"), where("traderId", "==", uid), orderBy("createdAt", "desc"), limit(500)) : null,
    [uid],
  );
  const history = useDoc<NetWorthHistory>(uid ? doc(fb().db, "netWorthHistory", uid) : null, [uid]);

  // Group my trades by stock for per-holding cost basis.
  const tradesByStock = useMemo(() => {
    const map = new Map<string, Trade[]>();
    for (const t of myTrades.data) {
      const list = map.get(t.stockId) ?? [];
      list.push(t);
      map.set(t.stockId, list);
    }
    return map;
  }, [myTrades.data]);

  if (!me) return <p className="muted">Admins without a player account have no portfolio.</p>;
  const view = playerById.get(me.uid);
  const myStock = stockById.get(me.uid);
  const heldByOthers = holdings.filter((h) => h.stockId === me.uid).reduce((a, h) => a + h.shares, 0);
  const weekChange = view && me.netWorthWeekStart > 0 ? view.netWorth / me.netWorthWeekStart - 1 : 0;

  // Net-worth history, with the live value appended as the latest point.
  const nwPoints = useMemo(() => {
    const pts = (history.data?.points ?? []).map((p) => ({ t: p.t, v: p.v }));
    if (view) pts.push({ t: Date.now(), v: view.netWorth });
    return pts;
  }, [history.data, view]);

  // Total unrealised P/L across all current holdings.
  const totalUnrealised = useMemo(
    () =>
      myHoldings.reduce((sum, h) => {
        const s = stockById.get(h.stockId);
        if (!s) return sum;
        return sum + positionFromTrades(tradesByStock.get(h.stockId) ?? [], s.price).unrealised;
      }, 0),
    [myHoldings, stockById, tradesByStock],
  );

  return (
    <div className="stack">
      <h1>Portfolio</h1>
      {me.isIdle && <div className="banner">You&apos;re marked idle — you&apos;ll reactivate automatically now you&apos;re back.</div>}
      <div className="stats">
        <Stat label="Cash" value={gbp(me.cash)} />
        <Stat label="Holdings" value={gbp(view?.holdingsValue)} sub={<span className={changeClass(totalUnrealised)}>{totalUnrealised >= 0 ? "+" : ""}{gbp(totalUnrealised)} unrealised</span>} />
        <Stat label="Net worth" value={gbp(view?.netWorth)} sub={<span className={changeClass(weekChange)}>{pct(weekChange)} this week</span>} />
        <Stat label="Score" value={(view?.score ?? 0).toFixed(3)} sub="net worth ÷ (start + allowances)" />
      </div>

      <section className="card">
        <h2>Net worth over time</h2>
        {nwPoints.length < 2 ? (
          <p className="muted small">Your net worth is charted after the first weekly close. Check back once a week has closed.</p>
        ) : (
          <LineChart points={nwPoints} label="Your net worth over time" />
        )}
      </section>

      <section className="card">
        <h2>Holdings</h2>
        {myHoldings.length === 0 ? (
          <p className="muted">You don&apos;t hold anything yet. <Link href="/market/">Browse the market</Link>.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Stock</th>
                  <th scope="col" className="num">Shares</th>
                  <th scope="col" className="num">Avg cost</th>
                  <th scope="col" className="num">Price</th>
                  <th scope="col" className="num">Value</th>
                  <th scope="col" className="num">Unrealised P/L</th>
                  <th scope="col"><span className="sr-only">Chart</span></th>
                </tr>
              </thead>
              <tbody>
                {myHoldings.map((h) => (
                  <HoldingRow key={h.stockId} stockId={h.stockId} trades={tradesByStock.get(h.stockId) ?? []} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {myStock && (
        <section className="card">
          <h2>Your stock</h2>
          {myStock.listed && <PhotoEditor />}
          <p>
            <Link href={stockHref(myStock.id)}>{myStock.displayName}</Link> trades at {gbp(myStock.price)}. Others hold{" "}
            {shares(heldByOthers)} shares ({gbp(heldByOthers * myStock.price)}), which earns you a CEO bonus of about{" "}
            {gbp(heldByOthers * myStock.price * config.bonusRate)} at weekly close.
          </p>
          <p className="small muted">
            Joined week {me.joinWeek} with {gbp(me.startingCash)} · allowances {gbp(me.totalAllowances)} · CEO bonuses {gbp(me.totalBonus)}
          </p>
        </section>
      )}

      <section className="card">
        <h2>Recent trades</h2>
        {myTrades.data.length === 0 ? (
          <p className="muted">No trades yet.</p>
        ) : (
          <ul className="plain">
            {myTrades.data.slice(0, 50).map((t) => (
              <li key={t.id} className="row between">
                <span>
                  {t.side === "buy" ? "Bought" : "Sold"} {shares(t.shares)} <Link href={stockHref(t.stockId)}>{t.stockName}</Link>
                </span>
                <span className="muted small">
                  {gbp(Math.abs(t.netCash))} · fee {gbp(t.fee)} · {ago(t.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One holdings row with its unrealised P/L and an expandable value-over-time chart. */
function HoldingRow({ stockId, trades }: { stockId: string; trades: Trade[] }) {
  const { stockById } = useGame();
  const [open, setOpen] = useState(false);
  const s = stockById.get(stockId);
  const pos = positionFromTrades(trades, s?.price ?? 0);

  // Position value over time: step line of (shares held so far × price at each trade).
  const points = useMemo(() => {
    const ordered = [...trades].sort((a, b) => a.createdAt - b.createdAt);
    let held = 0;
    const pts: { t: number; v: number }[] = [];
    for (const t of ordered) {
      held += t.side === "buy" ? t.shares : -t.shares;
      pts.push({ t: t.createdAt, v: Math.max(0, held) * t.priceAfter });
    }
    if (s) pts.push({ t: Date.now(), v: pos.shares * s.price });
    return pts;
  }, [trades, s, pos.shares]);

  if (!s) {
    return (
      <tr>
        <th scope="row">{stockId}</th>
        <td className="num" colSpan={6}>—</td>
      </tr>
    );
  }

  return (
    <>
      <tr>
        <th scope="row"><Link href={stockHref(s.id)}>{s.displayName}</Link></th>
        <td className="num">{shares(pos.shares)}</td>
        <td className="num">{gbp(pos.avgCost)}</td>
        <td className="num">{gbp(s.price)}</td>
        <td className="num">{gbp(pos.marketValue)}</td>
        <td className={`num ${changeClass(pos.unrealised)}`}>
          {pos.unrealised >= 0 ? "+" : ""}{gbp(pos.unrealised)} <span className="small">({pct(pos.unrealisedPct)})</span>
        </td>
        <td className="num">
          <button type="button" className="link small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Chart"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            {points.length < 2 ? (
              <p className="muted small">Not enough trades to chart this holding yet.</p>
            ) : (
              <LineChart points={points} label={`Your ${s.displayName} position value over time`} baseline={pos.costBasis} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="big">{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}
