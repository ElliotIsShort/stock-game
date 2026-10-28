"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { formatCountdown, nextScheduledClose, type Stock } from "@fsm/shared";
import { changeClass, gbp, pct, stockHref } from "@/lib/format";
import { liveContenders } from "@/lib/standings";
import { useNow } from "@/lib/useNow";
import { useGame } from "./GameProvider";

/** The strip under the top bar on every page: close countdown + who's winning, then the scrolling ticker tape. */
export function MarketStrip() {
  return (
    <div className="strip">
      <CloseCountdown />
      <TickerTape />
    </div>
  );
}

function CloseCountdown() {
  const { state, config, players, me } = useGame();
  const now = useNow(1000);
  const leader = liveContenders(players, state, config)[0];
  if (!state || now === null) return <div className="strip-close" />;

  const next = nextScheduledClose(now, state.lastCloseAt, config.minHoursBetweenAutoCloses);
  const when = new Date(next.at).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="strip-close">
      <span className="strip-timer" title={`Automatic close: ${when}`}>
        <span aria-hidden="true">⏱</span>{" "}
        <span className="strip-verbose">Week {state.currentWeek} </span>
        {next.due ? (
          "closing now…"
        ) : (
          <>
            <span className="strip-verbose">closes in </span>
            <time dateTime={new Date(next.at).toISOString()}>{formatCountdown(next.at - now)}</time>
          </>
        )}
      </span>
      {leader && (
        <Link href="/leaderboard/" className="strip-leader" title="Top weekly grower if the week closed now">
          <span aria-hidden="true">🏆</span>{" "}
          <span className="strip-leader-name">{leader.playerId === me?.uid ? "You" : leader.name}</span>{" "}
          <span className={changeClass(leader.growth)}>{pct(leader.growth)}</span>
        </Link>
      )}
    </div>
  );
}

/** Repeat the list until one copy is long enough to fill wide screens, so the loop never shows a gap. */
const MIN_ITEMS_PER_COPY = 12;
const SECONDS_PER_ITEM = 3;

function TickerTape() {
  const { stocks, tickerOf } = useGame();
  const listed = useMemo(
    () => stocks.filter((s) => s.listed).sort((a, b) => tickerOf(a.id).localeCompare(tickerOf(b.id))),
    [stocks, tickerOf],
  );
  if (listed.length === 0) return <div className="tape" />;

  const reps = Math.ceil(MIN_ITEMS_PER_COPY / listed.length);
  const copy = Array.from({ length: reps }, () => listed).flat();
  const style = { "--tape-duration": `${copy.length * SECONDS_PER_ITEM}s` } as CSSProperties;

  return (
    <div className="tape" role="region" aria-label="Ticker tape">
      <div className="tape-track" style={style}>
        {/* The first run is the accessible one; the repeats are decoration for a seamless loop. */}
        <ul className="tape-copy">
          {copy.map((s, i) => (
            <TapeItem key={`${s.id}-${i}`} stock={s} ticker={tickerOf(s.id)} hidden={i >= listed.length} />
          ))}
        </ul>
        <ul className="tape-copy" aria-hidden="true">
          {copy.map((s, i) => (
            <TapeItem key={`${s.id}-${i}`} stock={s} ticker={tickerOf(s.id)} hidden />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TapeItem({ stock, ticker, hidden }: { stock: Stock; ticker: string; hidden: boolean }) {
  const change = stock.weekOpenPrice > 0 ? stock.price / stock.weekOpenPrice - 1 : 0;
  const cls = changeClass(change);
  // Flash the price green/red when a live trade moves it.
  const prev = useRef(stock.price);
  const flash = stock.price > prev.current ? "flash-up" : stock.price < prev.current ? "flash-down" : "";
  useEffect(() => {
    prev.current = stock.price;
  }, [stock.price]);

  return (
    <li className="tape-item" aria-hidden={hidden || undefined}>
      <Link
        href={stockHref(stock.id)}
        tabIndex={hidden ? -1 : undefined}
        aria-label={hidden ? undefined : `${stock.displayName} ($${ticker}) ${gbp(stock.price)}, ${pct(change)} this week`}
      >
        <strong className="tape-ticker">{ticker}</strong>
        <span key={stock.price} className={`tape-price ${flash}`}>{gbp(stock.price)}</span>
        <span className={`tape-change ${cls}`}>
          {cls === "up" ? "▲" : cls === "down" ? "▼" : "■"} {pct(change)}
        </span>
      </Link>
    </li>
  );
}
