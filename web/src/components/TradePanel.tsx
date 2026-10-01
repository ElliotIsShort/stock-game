"use client";

import { useMemo, useState, type FormEvent } from "react";
import { quoteBuy, quoteSell, type Stock, type TradeSide } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { changeClass, gbp, pct, shares } from "@/lib/format";
import { useGame } from "./GameProvider";

/**
 * Trade form with a live preview. The preview uses the same AMM code as the
 * server, but the server recomputes everything from the live pool.
 */
export function TradePanel({ stock }: { stock: Stock }) {
  const { me, config, myHoldings } = useGame();
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [postText, setPostText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const held = myHoldings.find((h) => h.stockId === stock.id)?.shares ?? 0;
  const value = Number(amount);

  const quote = useMemo(() => {
    if (!(value > 0)) return null;
    try {
      return side === "buy" ? quoteBuy(stock, value, config.tradingFeePct) : quoteSell(stock, value, config.tradingFeePct);
    } catch {
      return null;
    }
  }, [side, value, stock, config.tradingFeePct]);

  if (!me) return <p className="muted">Only players can trade.</p>;
  if (!me.isActive) return <p className="muted">Your account is delisted.</p>;
  if (stock.ownerId === me.uid) return <p className="muted">You can&apos;t trade your own stock — but you can post about yourself.</p>;
  if (!stock.listed) return <p className="muted">This stock is delisted.</p>;

  const tooMuch = side === "buy" ? value > me.cash + 1e-6 : value > held + 1e-9;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!quote || tooMuch) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const t = await api.trade({ stockId: stock.id, side, amount: value, postText: postText.trim() || undefined });
      setDone(`${t.side === "buy" ? "Bought" : "Sold"} ${shares(t.shares)} shares at avg ${gbp(Math.abs(t.netCash) / t.shares)}.`);
      setAmount("");
      setPostText("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const move = quote ? quote.priceAfter / quote.priceBefore - 1 : 0;

  return (
    <form onSubmit={submit} className="card trade-panel">
      <div className="segmented" role="radiogroup" aria-label="Side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            className={side === s ? `active ${s}` : ""}
            onClick={() => {
              setSide(s);
              setAmount("");
            }}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <label>
        {side === "buy" ? "Cash to spend (£, fee included)" : "Shares to sell"}
        <div className="row">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={tooMuch}
          />
          <button type="button" onClick={() => setAmount(String(side === "buy" ? Math.floor(me.cash * 100) / 100 : held))}>
            Max
          </button>
        </div>
      </label>
      <p className="small muted">
        {side === "buy" ? `Cash available: ${gbp(me.cash)}` : `You hold ${shares(held)} shares (${gbp(held * stock.price)})`}
      </p>
      {quote && (
        <dl className="quote">
          <dt>{side === "buy" ? "You receive" : "You get"}</dt>
          <dd>{quote.side === "buy" ? `${shares(quote.shares)} shares` : gbp(quote.netCash)}</dd>
          <dt>Fee ({(config.tradingFeePct * 100).toFixed(2)}% → prize pool)</dt>
          <dd>{gbp(quote.fee)}</dd>
          <dt>Average price</dt>
          <dd>{gbp(quote.avgPrice)}</dd>
          <dt>Price after</dt>
          <dd>
            {gbp(quote.priceAfter)} <span className={changeClass(move)}>{pct(move)}</span>
          </dd>
        </dl>
      )}
      {tooMuch && <p className="error small" role="alert">{side === "buy" ? "Not enough cash." : "You don't hold that many shares."}</p>}
      <label>
        Add a post (optional)
        <textarea rows={2} maxLength={config.maxPostLength} value={postText} onChange={(e) => setPostText(e.target.value)} placeholder="Why? e.g. he's buying drinks tonight" />
      </label>
      <button type="submit" className={`primary ${side}`} disabled={busy || !quote || tooMuch}>
        {busy ? "Placing…" : side === "buy" ? `Buy ${stock.displayName}` : `Sell ${stock.displayName}`}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="success" role="status">{done}</p>}
    </form>
  );
}
