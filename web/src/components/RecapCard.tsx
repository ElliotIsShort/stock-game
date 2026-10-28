"use client";

import Link from "next/link";
import { alertSummary, type RecapTrader } from "@fsm/shared";
import { changeClass, duration, gbp, pct, profileHref, signedGbp } from "@/lib/format";
import { liveContenders } from "@/lib/standings";
import { useGame } from "./GameProvider";

function traderLine(t: RecapTrader): string {
  const parts: string[] = [];
  if (t.bought > 0) parts.push(`bought ${gbp(t.bought)}`);
  if (t.sold > 0) parts.push(`sold ${gbp(t.sold)}`);
  if (t.shorted > 0) parts.push(`shorted ${gbp(t.shorted)}`);
  if (t.covered > 0) parts.push(`covered ${gbp(t.covered)}`);
  return parts.join(", ");
}

/** "While you were away": shown at the top of the page after recapAfterHours away, until dismissed. */
export function RecapCard() {
  const { recap, dismissRecap, me, players, state, config, playerById } = useGame();
  if (!recap || !me) return null;
  const view = playerById.get(me.uid);
  const netNow = view?.netWorth ?? recap.netWorthNow;
  const rankNow = view?.rank ?? recap.rankNow;
  const nwDelta = recap.netWorthThen === null ? null : netNow - recap.netWorthThen;
  const rankDelta = recap.rankThen !== null && rankNow !== null ? recap.rankThen - rankNow : null;
  const leader = liveContenders(players, state, config)[0];
  const priceMove = recap.priceThen && recap.priceNow ? recap.priceNow / recap.priceThen - 1 : null;
  const firstName = me.displayName.split(" ")[0];

  return (
    <section className="card recap" aria-labelledby="recap-title">
      <div className="row between">
        <h2 id="recap-title">Welcome back, {firstName}</h2>
        <button type="button" className="link" onClick={dismissRecap} aria-label="Dismiss recap">✕</button>
      </div>
      <p className="muted small">While you were away ({duration(Date.now() - recap.since)}):</p>
      <dl className="recap-stats">
        <div>
          <dt>Net worth</dt>
          <dd>
            {gbp(netNow)}
            {nwDelta !== null && <span className={`small ${changeClass(nwDelta)}`}> {signedGbp(nwDelta)}</span>}
          </dd>
        </div>
        <div>
          <dt>Rank</dt>
          <dd>
            {rankNow === null ? "—" : `#${rankNow}`}
            {rankDelta !== null && rankDelta !== 0 && (
              <span className={`small ${rankDelta > 0 ? "up" : "down"}`}> {rankDelta > 0 ? `▲ ${rankDelta}` : `▼ ${-rankDelta}`}</span>
            )}
          </dd>
        </div>
        {priceMove !== null && (
          <div>
            <dt>Your stock</dt>
            <dd>
              {gbp(recap.priceNow)} <span className={`small ${changeClass(priceMove)}`}>{pct(priceMove)}</span>
            </dd>
          </div>
        )}
      </dl>
      <ul className="recap-list">
        {recap.weeksClosed > 0 && (
          <li>
            🔔 {recap.weeksClosed === 1 ? "A week closed" : `${recap.weeksClosed} weeks closed`}
            {recap.prizes.length > 0 && <> and you won <strong>{gbp(recap.prizes.reduce((a, p) => a + p.amount, 0))}</strong></>}.
          </li>
        )}
        {recap.traders.length === 0 ? (
          <li className="muted">Nobody traded your stock.</li>
        ) : (
          recap.traders.map((t) => (
            <li key={t.traderId}>
              <Link href={profileHref(t.traderId)}>{t.traderName}</Link> {traderLine(t)} of you{t.shorted > 0 ? " 👀" : ""}.
            </li>
          ))
        )}
        {recap.alertsTriggered.map((a, i) => (
          <li key={i}>🔔 Alert: {alertSummary(a.stockName, a.direction, a.price)}</li>
        ))}
        {leader && (
          <li>
            🏆 Right now {leader.playerId === me.uid ? <strong>you&apos;re</strong> : <><strong>{leader.name}</strong> is</>} leading the week at{" "}
            <span className={changeClass(leader.growth)}>{pct(leader.growth)}</span>.
          </li>
        )}
      </ul>
    </section>
  );
}
