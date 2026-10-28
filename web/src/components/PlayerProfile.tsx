"use client";

import Link from "next/link";
import { useMemo } from "react";
import { collection, doc, limit, orderBy, query, where } from "firebase/firestore";
import {
  AWARD_META,
  badgesFor,
  positionFromTrades,
  reportWinners,
  type NetWorthHistory,
  type Short,
  type Trade,
  type WeeklyReport,
} from "@fsm/shared";
import { fb } from "@/lib/firebase";
import { useDoc, useQuery } from "@/lib/hooks";
import { ago, changeClass, gbp, pct, shares, signedGbp, stockHref } from "@/lib/format";
import { liveGrowth } from "@/lib/standings";
import { DiscordLink } from "./DiscordLink";
import { useGame } from "./GameProvider";
import { LineChart } from "./LineChart";
import { StatCard } from "./StatCard";

interface Call {
  key: string;
  label: string;
  stockId: string;
  pnl: number;
  note: string;
}

/** The Player tab of a profile: stats, badges, net worth, weekly results, best/worst calls and recent trades. */
export function PlayerProfile({ uid }: { uid: string }) {
  const { playerById, stockById, me, players, tickerOf } = useGame();
  const db = fb().db;
  const player = playerById.get(uid);
  const isMe = me?.uid === uid;

  const history = useDoc<NetWorthHistory>(doc(db, "netWorthHistory", uid), [uid]);
  const reports = useQuery<WeeklyReport>(query(collection(db, "weeklyReports"), orderBy("week", "desc")), []);
  const trades = useQuery<Trade>(query(collection(db, "trades"), where("traderId", "==", uid), orderBy("createdAt", "desc"), limit(500)), [uid]);
  const closedShorts = useQuery<Short>(query(collection(db, "shorts"), where("ownerId", "==", uid), where("status", "==", "closed")), [uid]);

  const nwPoints = useMemo(() => {
    const pts = (history.data?.points ?? []).map((p) => ({ t: p.t, v: p.v }));
    if (player) pts.push({ t: Date.now(), v: player.netWorth });
    return pts;
  }, [history.data, player]);

  const badges = useMemo(
    () => badgesFor(uid, reports.data.map((r) => ({ week: r.week, winners: reportWinners(r), awards: r.highlights.awards })), player?.joinWeek ?? 0),
    [uid, reports.data, player?.joinWeek],
  );

  const weekly = useMemo(
    () =>
      reports.data
        .map((r) => {
          const i = r.highlights.growth.findIndex((g) => g.uid === uid);
          if (i < 0) return null;
          const prize = reportWinners(r).find((w) => w.playerId === uid)?.prizeAmount ?? 0;
          return { week: r.week, id: r.id, growth: r.highlights.growth[i].weeklyGrowth, place: i + 1, of: r.highlights.growth.length, prize, awards: (r.highlights.awards ?? []).filter((a) => a.playerId === uid) };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 12),
    [reports.data, uid],
  );

  // Best and worst calls: realised + unrealised P/L per stock traded, plus closed shorts.
  const calls = useMemo(() => {
    const byStock = new Map<string, Trade[]>();
    for (const t of trades.data) if (!t.kind) byStock.set(t.stockId, [...(byStock.get(t.stockId) ?? []), t]);
    const out: Call[] = [];
    for (const [stockId, list] of byStock) {
      const price = stockById.get(stockId)?.price ?? 0;
      const pos = positionFromTrades(list, price);
      const pnl = pos.realised + pos.unrealised;
      out.push({ key: `h-${stockId}`, label: list[0].stockName, stockId, pnl, note: pos.shares > 0 ? `holding ${shares(pos.shares)}` : "closed out" });
    }
    for (const s of closedShorts.data) {
      out.push({ key: `s-${s.id}`, label: `Short on ${s.stockName}`, stockId: s.stockId, pnl: s.realisedPnl ?? 0, note: `closed week ${s.closeWeek ?? "?"}` });
    }
    const sorted = out.filter((c) => Math.abs(c.pnl) >= 0.01).sort((a, b) => b.pnl - a.pnl);
    return { best: sorted.filter((c) => c.pnl > 0).slice(0, 3), worst: sorted.filter((c) => c.pnl < 0).reverse().slice(0, 3) };
  }, [trades.data, closedShorts.data, stockById]);

  if (!player) return <p className="muted">No player profile for this stock.</p>;
  const growth = liveGrowth(player);
  const rankedCount = players.filter((p) => p.rank !== null).length;

  return (
    <div className="stack">
      <div className="stats">
        <StatCard label="Net worth" value={player.netWorth} spark={nwPoints.map((p) => p.v)} />
        <StatCard label="Score" value={player.score} format={(n) => n.toFixed(3)} />
        <div className="stat">
          <div className="muted small">Rank</div>
          <div className="big">{player.rank === null ? "—" : `#${player.rank}`}</div>
          <div className="small muted">{player.rank === null ? (player.isIdle ? "idle" : "unranked") : `of ${rankedCount}`}</div>
        </div>
        <div className="stat">
          <div className="muted small">This week</div>
          <div className={`big ${changeClass(growth)}`}>{pct(growth, 2)}</div>
          <div className="small muted">Joined week {player.joinWeek}</div>
        </div>
      </div>

      <section className="card" aria-labelledby="badges-title">
        <h2 id="badges-title">Badges</h2>
        {badges.length === 0 ? (
          <p className="muted small">No badges yet. Weekly prizes and awards ({Object.values(AWARD_META).map((a) => a.title).join(", ")}) show up here.</p>
        ) : (
          <ul className="badges">
            {badges.map((b) => (
              <li key={b.key} className="badge-chip" title={`Week${b.weeks.length === 1 ? "" : "s"} ${b.weeks.join(", ")}`}>
                <span aria-hidden="true">{b.emoji}</span> {b.title}
                {b.count > 1 && <span className="muted"> ×{b.count}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Net worth over time</h2>
        {nwPoints.length < 2 ? (
          <p className="muted small">Charted after the first weekly close.</p>
        ) : (
          <LineChart points={nwPoints} label={`${player.displayName}'s net worth over time`} ranges={["1M", "3M", "1Y"]} height={200} />
        )}
      </section>

      <div className="grid-2 even">
        <section className="card">
          <h2>Best calls</h2>
          <CallList calls={calls.best} empty="No winning trades yet." tickerOf={tickerOf} />
        </section>
        <section className="card">
          <h2>Worst calls</h2>
          <CallList calls={calls.worst} empty="No losing trades yet." tickerOf={tickerOf} />
        </section>
      </div>

      <section className="card">
        <h2>Weekly results</h2>
        {weekly.length === 0 ? (
          <p className="muted small">No closed weeks yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  <th scope="col" className="num">Growth</th>
                  <th scope="col" className="num">Place</th>
                  <th scope="col" className="num">Prize</th>
                  <th scope="col">Awards</th>
                </tr>
              </thead>
              <tbody>
                {weekly.map((w) => (
                  <tr key={w.week}>
                    <th scope="row"><Link href={`/report/?id=${w.id}`}>Week {w.week}</Link></th>
                    <td className={`num ${changeClass(w.growth)}`}>{pct(w.growth, 2)}</td>
                    <td className="num">{w.place} / {w.of}</td>
                    <td className="num">{w.prize > 0 ? gbp(w.prize) : <span className="muted">—</span>}</td>
                    <td>{w.awards.map((a) => <span key={a.key} title={a.title}>{a.emoji} </span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Recent trades</h2>
        {trades.data.length === 0 ? (
          <p className="muted small">No trades yet.</p>
        ) : (
          <ul className="plain">
            {trades.data.slice(0, 10).map((t) => (
              <li key={t.id} className="row between">
                <span>
                  {t.kind === "openShort" ? "Shorted" : t.kind === "closeShort" ? "Covered" : t.side === "buy" ? "Bought" : "Sold"} {shares(t.shares)}{" "}
                  <Link href={stockHref(t.stockId)}>{t.stockName}</Link>
                </span>
                <span className="muted small">{gbp(t.cashAmount)} · {ago(t.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isMe && (
        <section className="card stack" aria-labelledby="settings-title">
          <h2 id="settings-title">Discord</h2>
          <p className="small muted">Link your Discord account so the market can @mention you when someone trades your stock, you win, or an alert fires.</p>
          <DiscordLink />
        </section>
      )}
    </div>
  );
}

function CallList({ calls, empty, tickerOf }: { calls: Call[]; empty: string; tickerOf: (id: string) => string }) {
  if (calls.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="plain">
      {calls.map((c) => (
        <li key={c.key} className="row between">
          <span>
            <Link href={stockHref(c.stockId)}>{c.label}</Link> <span className="ticker-chip">${tickerOf(c.stockId)}</span>
            <span className="muted small"> · {c.note}</span>
          </span>
          <strong className={changeClass(c.pnl)}>{signedGbp(c.pnl)}</strong>
        </li>
      ))}
    </ul>
  );
}
