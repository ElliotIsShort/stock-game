"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import type { Trade } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { ago, changeClass, gbp, pct, shares, stockHref } from "@/lib/format";

export default function PortfolioPage() {
  const { me, playerById, myHoldings, stockById, holdings, config } = useGame();
  const uid = me?.uid ?? null;
  const myTrades = useQuery<Trade>(
    uid ? query(collection(fb().db, "trades"), where("traderId", "==", uid), orderBy("createdAt", "desc"), limit(50)) : null,
    [uid],
  );

  if (!me) return <p className="muted">Admins without a player account have no portfolio.</p>;
  const view = playerById.get(me.uid);
  const myStock = stockById.get(me.uid);
  const heldByOthers = holdings.filter((h) => h.stockId === me.uid).reduce((a, h) => a + h.shares, 0);
  const weekChange = view && me.netWorthWeekStart > 0 ? view.netWorth / me.netWorthWeekStart - 1 : 0;

  return (
    <div className="stack">
      <h1>Portfolio</h1>
      {me.isIdle && <div className="banner">You&apos;re marked idle — you&apos;ll reactivate automatically now you&apos;re back.</div>}
      <div className="stats">
        <Stat label="Cash" value={gbp(me.cash)} />
        <Stat label="Holdings" value={gbp(view?.holdingsValue)} />
        <Stat label="Net worth" value={gbp(view?.netWorth)} sub={<span className={changeClass(weekChange)}>{pct(weekChange)} this week</span>} />
        <Stat label="Score" value={(view?.score ?? 0).toFixed(3)} sub="net worth ÷ (start + allowances)" />
      </div>

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
                  <th scope="col" className="num">Price</th>
                  <th scope="col" className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {myHoldings.map((h) => {
                  const s = stockById.get(h.stockId);
                  return (
                    <tr key={h.stockId}>
                      <th scope="row">{s ? <Link href={stockHref(s.id)}>{s.displayName}</Link> : h.stockId}</th>
                      <td className="num">{shares(h.shares)}</td>
                      <td className="num">{gbp(s?.price)}</td>
                      <td className="num">{s ? gbp(h.shares * s.price) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {myStock && (
        <section className="card">
          <h2>Your stock</h2>
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
            {myTrades.data.map((t) => (
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="big">{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}
