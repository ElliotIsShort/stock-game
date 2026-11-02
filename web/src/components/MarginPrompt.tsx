"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatCloseTime, marginStatus, planLiquidation, quoteSell, type MarginShort, type MarginStatus } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { gbp, shares as fmtShares, stockHref } from "@/lib/format";
import { playSound } from "@/lib/sound";
import { useGame } from "./GameProvider";

/** The signed-in player's live margin status (same maths as the server). */
export function useMyMargin(): MarginStatus | null {
  const { me, myShorts, stockById, config } = useGame();
  return useMemo(() => {
    if (!me) return null;
    const poolOf = (id: string) => {
      const s = stockById.get(id);
      return s && s.listed ? s : undefined;
    };
    return marginStatus(me.cash, myShorts, poolOf, config);
  }, [me, myShorts, stockById, config]);
}

/** Banner while margin called: amount owed, deadline, and a link to the sell prompt. */
export function MarginCallBanner() {
  const { me } = useGame();
  const live = useMyMargin();
  if (!me?.marginCall) return null;
  const owed = live && live.level === "call" ? live.shortfall : me.marginCall.shortfall;
  return (
    <div className="banner margin-banner" role="alert">
      <strong>Margin call:</strong> raise {gbp(owed)} by {formatCloseTime(me.marginCall.deadline)} (UK time), or holdings will be force-sold to cover
      your shorts. <Link href="/portfolio/#margin">Raise cash</Link>
    </div>
  );
}

/**
 * "Raise £Y to cover": your holdings with their value, a one-tap "sell enough
 * to cover" (previewed with the shared AMM quotes, largest holding first, like
 * a forced sale would), and a sell button per holding. Every sale is a normal
 * `trade` call.
 */
export function RaiseCash({ shorts, title }: { shorts: MarginShort[]; title?: string }) {
  const { me, myHoldings, stockById, config } = useGame();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const poolOf = (id: string) => {
    const s = stockById.get(id);
    return s && s.listed ? s : undefined;
  };
  const status = me ? marginStatus(me.cash, shorts, poolOf, config) : null;
  const need = status ? Math.max(0, status.coverCost - status.cash) : 0;
  const plan = me ? planLiquidation(me.cash, myHoldings, shorts, poolOf, config.tradingFeePct) : null;
  const rows = myHoldings
    .map((h) => ({ h, s: stockById.get(h.stockId) }))
    .filter((r) => r.s && r.s.listed && r.h.shares > 0)
    .sort((a, b) => b.h.shares * b.s!.price - a.h.shares * a.s!.price);

  if (!me || !status) return null;

  async function sell(sales: { stockId: string; shares: number }[]) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      let raised = 0;
      for (const s of sales) {
        const t = await api.trade({ stockId: s.stockId, side: "sell", amount: s.shares });
        raised += t.netCash;
      }
      playSound("sell");
      setDone(`Sold for ${gbp(raised)}. ${raised + 0.005 >= need ? "You can cover your shorts now." : ""}`.trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack raise-cash">
      <h3>{title ?? `Raise ${gbp(need)} to cover your shorts`}</h3>
      {need <= 0.005 ? (
        <p className="success small">Your cash covers your shorts now ({gbp(status.coverCost)} to buy them back).</p>
      ) : (
        <p className="small muted">
          Buying your shorts back costs {gbp(status.coverCost)}; you have {gbp(status.cash)} cash.
          {status.uncoverable.length > 0 && " Part of it can't be bought back at today's pool depth."}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="small muted">You don&apos;t hold anything to sell.</p>
      ) : (
        <>
          {need > 0.005 && plan && plan.sales.length > 0 && (
            <div className="row wrap">
              <button type="button" className="primary sell" disabled={busy} onClick={() => sell(plan.sales.map((s) => ({ stockId: s.stockId, shares: s.shares })))}>
                Sell enough to cover
              </button>
              <span className="small muted">
                {plan.sales.map((s) => `${fmtShares(s.shares)} ${stockById.get(s.stockId)?.displayName ?? ""}`).join(", ")} for about{" "}
                {gbp(plan.sales.reduce((a, s) => a + s.netCash, 0))}
                {!plan.solvent && " (not enough on its own)"}
              </span>
            </div>
          )}
          <ul className="plain">
            {rows.map(({ h, s }) => {
              let net = 0;
              try {
                net = quoteSell(s!, h.shares, config.tradingFeePct).netCash;
              } catch {
                net = 0;
              }
              return (
                <li key={h.stockId} className="row between wrap">
                  <span>
                    <Link href={stockHref(h.stockId)}>{s!.displayName}</Link>{" "}
                    <span className="muted small">{fmtShares(h.shares)} shares · worth {gbp(h.shares * s!.price)} · sells for about {gbp(net)}</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => sell([{ stockId: h.stockId, shares: h.shares }])}>Sell all</button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      {done && <p className="success small" role="status">{done}</p>}
    </div>
  );
}
