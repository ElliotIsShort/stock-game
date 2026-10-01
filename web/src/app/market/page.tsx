"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { median } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { changeClass, gbp, pct, shares, stockHref } from "@/lib/format";

type SortKey = "name" | "price" | "change" | "trades";

export default function MarketPage() {
  const { stocks, playerById, myHoldings, me } = useGame();
  const [sort, setSort] = useState<SortKey>("change");

  const rows = useMemo(() => {
    const list = stocks.filter((s) => s.listed).map((s) => ({
      s,
      change: s.weekOpenPrice > 0 ? s.price / s.weekOpenPrice - 1 : 0,
      held: myHoldings.find((h) => h.stockId === s.id)?.shares ?? 0,
      idle: playerById.get(s.ownerId)?.isIdle ?? false,
    }));
    const cmp: Record<SortKey, (a: (typeof list)[0], b: (typeof list)[0]) => number> = {
      name: (a, b) => a.s.displayName.localeCompare(b.s.displayName),
      price: (a, b) => b.s.price - a.s.price,
      change: (a, b) => b.change - a.change,
      trades: (a, b) => b.s.weekTradeCount - a.s.weekTradeCount,
    };
    return list.sort(cmp[sort]);
  }, [stocks, myHoldings, playerById, sort]);

  const med = median(rows.map((r) => r.s.price));

  return (
    <div className="stack">
      <div className="row between">
        <h1>Market</h1>
        <span className="pill">Median price {gbp(med)}</span>
      </div>
      <label className="inline">
        Sort by{" "}
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="change">Week change</option>
          <option value="price">Price</option>
          <option value="trades">Trades this week</option>
          <option value="name">Name</option>
        </select>
      </label>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Stock</th>
              <th scope="col" className="num">Price</th>
              <th scope="col" className="num">Week</th>
              <th scope="col" className="num">Trades</th>
              <th scope="col" className="num">You hold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, change, held, idle }) => (
              <tr key={s.id} className={idle ? "idle" : undefined}>
                <th scope="row">
                  <Link href={stockHref(s.id)}>{s.displayName}</Link>
                  {s.id === me?.uid && <span className="muted small"> (you)</span>}
                  {idle && <span className="muted small"> · idle</span>}
                </th>
                <td className="num">{gbp(s.price)}</td>
                <td className={`num ${changeClass(change)}`}>{pct(change)}</td>
                <td className="num">{s.weekTradeCount}</td>
                <td className="num">{held > 0 ? `${shares(held)} (${gbp(held * s.price)})` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted">No stocks listed yet.</p>}
    </div>
  );
}
