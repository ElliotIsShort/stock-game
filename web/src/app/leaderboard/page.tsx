"use client";

import { weeklyGrowth } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { changeClass, gbp, pct } from "@/lib/format";

export default function LeaderboardPage() {
  const { players, me, state } = useGame();
  const listed = players.filter((p) => p.isActive);
  // Idle players are shown greyed and not ranked (§5).
  const ranked = listed.filter((p) => !p.isIdle).sort((a, b) => b.score - a.score);
  const idle = listed.filter((p) => p.isIdle).sort((a, b) => b.score - a.score);
  // Live weekly growth so far (allowance for this week isn't paid until close).
  const growthOf = (p: (typeof players)[0]) => weeklyGrowth(p.netWorthWeekStart, p.netWorth, 0);
  const leader = [...ranked].sort((a, b) => growthOf(b) - growthOf(a))[0];

  return (
    <div className="stack">
      <h1>Leaderboard</h1>
      <p className="muted">
        Score = net worth ÷ (starting cash + allowances received). Everyone starts at 1.00.
        {leader && state && (
          <> Currently leading week {state.currentWeek} for the {gbp(state.prizePool)} prize: <strong>{leader.displayName}</strong> ({pct(growthOf(leader), 2)}).</>
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
            </tr>
          </thead>
          <tbody>
            {[...ranked, ...idle].map((p, i) => {
              const g = growthOf(p);
              return (
                <tr key={p.uid} className={`${p.isIdle ? "idle" : ""} ${p.uid === me?.uid ? "me-row" : ""}`}>
                  <td>{p.isIdle ? "—" : i + 1}</td>
                  <th scope="row">
                    {p.displayName}
                    {p.isIdle && <span className="small"> (idle)</span>}
                  </th>
                  <td className="num">{p.score.toFixed(3)}</td>
                  <td className="num">{gbp(p.netWorth)}</td>
                  <td className={`num ${changeClass(g)}`}>{pct(g, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
