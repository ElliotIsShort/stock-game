"use client";

import { Fragment } from "react";
import { prizeSplitText, weeklyGrowth, weeklyPrizeWinners } from "@fsm/shared";
import { Avatar } from "@/components/Avatar";
import { useGame } from "@/components/GameProvider";
import { changeClass, gbp, pct } from "@/lib/format";

export default function LeaderboardPage() {
  const { players, me, state, config } = useGame();
  const listed = players.filter((p) => p.isActive);
  // Idle players are shown greyed and not ranked (§5).
  const ranked = listed.filter((p) => !p.isIdle).sort((a, b) => b.score - a.score);
  const idle = listed.filter((p) => p.isIdle).sort((a, b) => b.score - a.score);
  // Live weekly growth so far (allowance for this week isn't paid until close).
  const growthOf = (p: (typeof players)[0]) => weeklyGrowth(p.netWorthWeekStart, p.netWorth, 0);
  // Who would share the prize pool if the week closed now (same eligibility + split as the close).
  const contenders = state
    ? weeklyPrizeWinners(
        listed.map((p) => ({ playerId: p.uid, name: p.displayName, growth: growthOf(p), netWorthStart: p.netWorthWeekStart, isIdle: p.isIdle })),
        state.prizePool,
        config.prizeSplitPct,
      )
    : [];
  const projectedPrize = new Map(contenders.map((w) => [w.playerId, w.prizeAmount]));

  return (
    <div className="stack">
      <h1>Leaderboard</h1>
      <p className="muted">
        Score = net worth ÷ (starting cash + allowances received). Everyone starts at 1.00.
        {state && contenders.length > 0 && (
          <>
            {" "}The week {state.currentWeek} prize pool of {gbp(state.prizePool)} is split {prizeSplitText(config.prizeSplitPct)} among the
            top weekly growers. In the money right now:{" "}
            {contenders.map((w, i) => (
              <Fragment key={w.playerId}>
                {i > 0 && ", "}
                <strong>{w.name}</strong> ({pct(w.growth, 2)}, {gbp(w.prizeAmount)})
              </Fragment>
            ))}
            .
          </>
        )}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Player</th>
              <th scope="col" className="num">Score</th>
              <th scope="col" className="num">Net worth</th>
              <th scope="col" className="num">This week</th>
              <th scope="col" className="num" title="Share of the prize pool if the week closed now">Prize now</th>
            </tr>
          </thead>
          <tbody>
            {[...ranked, ...idle].map((p, i) => {
              const g = growthOf(p);
              const prize = projectedPrize.get(p.uid);
              return (
                <tr key={p.uid} className={`${p.isIdle ? "idle" : ""} ${p.uid === me?.uid ? "me-row" : ""}`}>
                  <td>{p.isIdle ? "—" : i + 1}</td>
                  <th scope="row">
                    <span className="with-avatar">
                      <Avatar uid={p.uid} name={p.displayName} />
                      <span>
                        {p.displayName}
                        {p.isIdle && <span className="small"> (idle)</span>}
                      </span>
                    </span>
                  </th>
                  <td className="num">{p.score.toFixed(3)}</td>
                  <td className="num">{gbp(p.netWorth)}</td>
                  <td className={`num ${changeClass(g)}`}>{pct(g, 2)}</td>
                  <td className="num">{prize === undefined ? <span className="muted">—</span> : gbp(prize)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
