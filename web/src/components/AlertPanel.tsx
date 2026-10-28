"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { alertSummary, validateAlert, type AlertDirection, type PriceAlert, type Stock } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { gbp, profileHref, stockHref } from "@/lib/format";
import { useGame } from "./GameProvider";

/** "Tell me when James drops below £50": set and cancel price alerts on one stock. */
export function AlertPanel({ stock }: { stock: Stock }) {
  const { me, myAlerts, config } = useGame();
  const [direction, setDirection] = useState<AlertDirection>("below");
  const [price, setPrice] = useState(() => (Math.round(stock.price * 0.9 * 100) / 100).toFixed(2));
  const [discord, setDiscord] = useState(Boolean(me?.discordId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me?.isActive || !stock.listed) return null;
  const mine = myAlerts.filter((a) => a.stockId === stock.id);
  const value = Number(price);
  const check = validateAlert(direction, value, stock.price);
  const full = myAlerts.length >= config.maxActiveAlerts;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!check.ok || full) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAlert({ stockId: stock.id, direction, price: value, discord: discord && Boolean(me?.discordId) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack alert-panel" aria-labelledby="alerts-title">
      <h2 id="alerts-title">Price alert</h2>
      <form className="alert-form" onSubmit={submit}>
        <span>Tell me when {stock.displayName}</span>
        <label className="sr-only" htmlFor="alert-direction">Direction</label>
        <select
          id="alert-direction"
          value={direction}
          onChange={(e) => {
            const d = e.target.value as AlertDirection;
            setDirection(d);
            setPrice((Math.round(stock.price * (d === "below" ? 0.9 : 1.1) * 100) / 100).toFixed(2));
          }}
        >
          <option value="below">drops below</option>
          <option value="above">rises above</option>
        </select>
        <span className="row alert-price">
          <span aria-hidden="true">£</span>
          <label className="sr-only" htmlFor="alert-price">Price</label>
          <input id="alert-price" type="number" inputMode="decimal" min="0.01" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={price !== "" && !check.ok} />
        </span>
        <button type="submit" className="primary" disabled={busy || !check.ok || full}>{busy ? "Saving…" : "Set alert"}</button>
      </form>
      <label className="inline small">
        <input type="checkbox" checked={discord && Boolean(me.discordId)} disabled={!me.discordId} onChange={(e) => setDiscord(e.target.checked)} style={{ width: "auto" }} />
        Also @mention me on Discord
        {!me.discordId && <span className="muted"> (<Link href={profileHref(me.uid)}>link Discord</Link> first)</span>}
      </label>
      <p className="small muted">Now {gbp(stock.price)}. {!check.ok && price !== "" ? check.error : "You'll get a notification here when it happens."}</p>
      {full && <p className="small error">You have {myAlerts.length} active alerts, the most allowed. Cancel one first.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      {mine.length > 0 && <AlertList alerts={mine} />}
    </section>
  );
}

/** Active alerts with a cancel button. `withStock` adds a link to each alert's stock (portfolio list). */
export function AlertList({ alerts, withStock = false }: { alerts: PriceAlert[]; withStock?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ul className="plain">
        {alerts.map((a) => (
          <li key={a.id} className="row between">
            <span>
              🔔 {withStock ? <Link href={stockHref(a.stockId)}>{a.stockName}</Link> : a.stockName}{" "}
              {alertSummary("", a.direction, a.price).trim()}
              {a.discord && <span className="muted small"> · Discord</span>}
            </span>
            <button
              type="button"
              className="link small danger"
              onClick={() => api.cancelAlert(a.id).catch((err) => setError(errorMessage(err)))}
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error small" role="alert">{error}</p>}
    </>
  );
}
