"use client";

import { useMemo, useState, type FormEvent } from "react";
import { quoteCloseShort, quoteOpenShort, shortUnrealised, type Stock } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { changeClass, gbp, pct, shares as fmtShares } from "@/lib/format";
import { useGame } from "./GameProvider";

/**
 * Open a short on this stock, and manage any open shorts you hold on it.
 * A short sells shares you don't own into the pool (price falls, you get cash);
 * closing buys them back. You profit if the price fell. Capped by your capital.
 */
export function ShortPanel({ stock }: { stock: Stock }) {
  const { me, config, myShorts, players } = useGame();
  const [shares, setShares] = useState("");
  const [openPost, setOpenPost] = useState("");
  const [closePostFor, setClosePostFor] = useState<string | null>(null);
  const [closePost, setClosePost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mineOnThis = myShorts.filter((s) => s.stockId === stock.id);
  const value = Number(shares);

  const openQuote = useMemo(() => {
    if (!(value > 0)) return null;
    try {
      return quoteOpenShort(stock, value, config.tradingFeePct);
    } catch {
      return null;
    }
  }, [value, stock, config.tradingFeePct]);

  if (!me) return null;
  if (!me.isActive) return null;
  if (stock.ownerId === me.uid) return null; // can't short your own stock

  // Capital = cash + holdings value (open-short paper gains excluded, matching the server).
  const meView = players.find((p) => p.uid === me.uid);
  const capital = me.cash + (meView?.holdingsValue ?? 0);
  const limit = capital * config.maxShortExposurePct;

  async function openShort(e: FormEvent) {
    e.preventDefault();
    if (!openQuote) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.openShort({ stockId: stock.id, shares: value, postText: openPost.trim() || undefined });
      setDone(`Opened a short on ${fmtShares(value)} shares. You received ${gbp(openQuote.proceeds)}.`);
      setShares("");
      setOpenPost("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function close(shortId: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.closeShort({ shortId, postText: closePost.trim() || undefined });
      const pnl = res.realisedPnl ?? 0;
      setDone(`Closed short. ${pnl >= 0 ? "Profit" : "Loss"}: ${gbp(Math.abs(pnl))}.`);
      setClosePostFor(null);
      setClosePost("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card short-panel">
      <h2>Short {stock.displayName}</h2>
      <p className="small muted">
        Bet the price will fall: sell shares you don&apos;t own now, buy them back later. You profit if it drops. A {pct(config.shortBorrowFeePct)} fee
        is charged each week you keep it open. You can short up to {pct(config.maxShortExposurePct)} of your capital — about {gbp(limit)}.
      </p>

      {mineOnThis.length > 0 && (
        <div className="stack">
          <h3 className="small">Your open shorts on {stock.displayName}</h3>
          <ul className="plain">
            {mineOnThis.map((s) => {
              let live = 0;
              try {
                live = shortUnrealised(s, quoteCloseShort(stock, s.shares, config.tradingFeePct).cost);
              } catch {
                live = 0;
              }
              return (
                <li key={s.id} className="stack">
                  <div className="row between">
                    <span>
                      {fmtShares(s.shares)} @ opened {gbp(s.openPrice)}{" "}
                      <span className={changeClass(live)}>({live >= 0 ? "+" : ""}{gbp(live)} if closed now)</span>
                    </span>
                    {closePostFor === s.id ? (
                      <button type="button" disabled={busy} onClick={() => { setClosePostFor(null); setClosePost(""); }}>Cancel</button>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => { setClosePostFor(s.id); setClosePost(""); }}>Close…</button>
                    )}
                  </div>
                  {closePostFor === s.id && (
                    <div className="stack">
                      <textarea
                        rows={2}
                        maxLength={config.maxPostLength}
                        value={closePost}
                        onChange={(e) => setClosePost(e.target.value)}
                        placeholder="Add a post (optional) — why are you closing?"
                      />
                      <button type="button" className="primary" disabled={busy} onClick={() => close(s.id)}>
                        {busy ? "Closing…" : "Confirm close"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <form onSubmit={openShort} className="stack">
        <label>
          Shares to short
          <input type="number" inputMode="decimal" min="0" step="any" value={shares} onChange={(e) => setShares(e.target.value)} />
        </label>
        {openQuote && (
          <dl className="quote">
            <dt>You receive now</dt>
            <dd>{gbp(openQuote.proceeds)}</dd>
            <dt>Price after</dt>
            <dd>{gbp(openQuote.priceAfter)} <span className={changeClass(openQuote.priceAfter / openQuote.priceBefore - 1)}>{pct(openQuote.priceAfter / openQuote.priceBefore - 1)}</span></dd>
          </dl>
        )}
        <label>
          Add a post (optional)
          <textarea rows={2} maxLength={config.maxPostLength} value={openPost} onChange={(e) => setOpenPost(e.target.value)} placeholder="Why? e.g. they're getting divorced" />
        </label>
        <button type="submit" className="primary" disabled={busy || !openQuote}>Open short</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
      {done && <p className="success small" role="status">{done}</p>}
    </div>
  );
}
