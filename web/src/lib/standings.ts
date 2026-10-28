import { weeklyGrowth, weeklyPrizeWinners, type GameConfig, type GameState, type PrizeWinner } from "@fsm/shared";
import type { PlayerView } from "@/components/GameProvider";

/** Live weekly growth so far (this week's allowance isn't paid until close). */
export function liveGrowth(p: PlayerView): number {
  return weeklyGrowth(p.netWorthWeekStart, p.netWorth, 0);
}

/** Who would share the prize pool if the week closed now (same eligibility + split as the close). */
export function liveContenders(players: PlayerView[], state: GameState | null, config: GameConfig): PrizeWinner[] {
  if (!state) return [];
  return weeklyPrizeWinners(
    players
      .filter((p) => p.isActive)
      .map((p) => ({ playerId: p.uid, name: p.displayName, growth: liveGrowth(p), netWorthStart: p.netWorthWeekStart, isIdle: p.isIdle })),
    state.prizePool,
    config.prizeSplitPct,
  );
}
