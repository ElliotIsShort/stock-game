import { HttpsError } from "firebase-functions/v2/https";
import {
  ceoBonus,
  isIdleSince,
  leaderboardScore,
  mean,
  mechanicsExplainer,
  median,
  netWorth,
  reportToMarkdown,
  targetPoolCash,
  topUpPool,
  weeklyGrowth,
  type GrowthRow,
  type LeaderboardRow,
  type Player,
  type PlayerSnapshot,
  type Post,
  type ReportFlag,
  type Stock,
  type StockWeekStats,
  type Trade,
  type TradeMove,
  type WeeklyReport,
} from "@fsm/shared";
import { auditEntry, auditRef, db, holdingsByUid, readConfig, readState, readWorld, refs } from "./common";

export interface CloseOptions {
  trigger: "admin" | "cron";
  actorId: string | null;
  /** Admin closes pass the week they saw, so a double-click can't close two weeks. */
  expectedWeek?: number;
}

export type CloseResult =
  | { closed: true; week: number; reportId: string; winner: string | null; prize: number }
  | { closed: false; reason: string };

/**
 * §6 weekly close, in order:
 *   snapshot → allowance → CEO bonus → pool top-up → leaderboard + winner →
 *   pay prize → store report.
 * Runs as a single Firestore transaction so balances are never half-updated
 * and trades can't interleave with the close.
 */
export async function closeWeek(opts: CloseOptions): Promise<CloseResult> {
  const now = Date.now();

  return db.runTransaction(async (tx): Promise<CloseResult> => {
    // ---------- Reads ----------
    const cfg = await readConfig(tx);
    const { state } = await readState(tx, now);
    const week = state.currentWeek;

    if (opts.expectedWeek !== undefined && opts.expectedWeek !== week) {
      throw new HttpsError("failed-precondition", `Week ${opts.expectedWeek} is already closed (current week is ${week}).`);
    }
    if (opts.trigger === "cron" && state.lastCloseAt !== null) {
      const hours = (now - state.lastCloseAt) / 3_600_000;
      if (hours < cfg.minHoursBetweenAutoCloses) {
        return { closed: false, reason: `Last close was ${hours.toFixed(1)}h ago (min ${cfg.minHoursBetweenAutoCloses}h).` };
      }
    }

    const world = await readWorld(tx);
    const [tradesSnap, postsSnap, prevSnap] = await Promise.all([
      tx.get(db.collection("trades").where("week", "==", week)),
      tx.get(db.collection("posts").where("week", "==", week)),
      tx.get(refs.report(week - 1)),
    ]);
    const trades = tradesSnap.docs.map((d) => d.data() as Trade);
    const posts = postsSnap.docs.map((d) => d.data() as Post).filter((p) => !p.system);
    const prevReport = prevSnap.exists ? (prevSnap.data() as WeeklyReport) : null;

    // Mutable working copies.
    const players = new Map<string, Player>(world.players.filter((p) => p.isActive).map((p) => [p.uid, { ...p }]));
    const stocks = new Map<string, Stock>(world.stocks.filter((s) => s.listed).map((s) => [s.id, { ...s }]));
    const byUid = holdingsByUid(world.holdings);
    const priceOf = (id: string) => stocks.get(id)?.price;
    const worthOf = (p: Player) => netWorth(p.cash, byUid.get(p.uid) ?? [], priceOf);
    const holdingsValueOf = (p: Player) => worthOf(p) - p.cash;

    // ---------- Idle flagging (§5) ----------
    const newlyIdle: string[] = [];
    for (const p of players.values()) {
      const idle = isIdleSince(p.lastActiveAt, now, cfg.idleThresholdWeeks);
      if (idle && !p.isIdle) newlyIdle.push(p.displayName);
      p.isIdle = idle;
    }
    const earning = () => [...players.values()].filter((p) => !p.isIdle);

    // ---------- 1. Snapshot all balances ----------
    const snapshot: PlayerSnapshot[] = [...players.values()].map((p) => ({
      uid: p.uid,
      name: p.displayName,
      cash: p.cash,
      holdingsValue: holdingsValueOf(p),
      netWorth: worthOf(p),
      isIdle: p.isIdle,
    }));

    // ---------- 2. Weekly allowance to active players ----------
    const allowanceOf = new Map<string, number>();
    for (const p of earning()) {
      p.cash += cfg.weeklyAllowance;
      p.totalAllowances += cfg.weeklyAllowance;
      allowanceOf.set(p.uid, cfg.weeklyAllowance);
    }
    const allowancesPaid = cfg.weeklyAllowance * allowanceOf.size;

    // ---------- 3. CEO bonus ----------
    const heldByOthers = new Map<string, number>();
    for (const h of world.holdings) {
      if (h.uid === h.stockId) continue;
      heldByOthers.set(h.stockId, (heldByOthers.get(h.stockId) ?? 0) + h.shares);
    }
    const bonusOf = new Map<string, number>();
    for (const p of earning()) {
      const stock = stocks.get(p.uid);
      if (!stock) continue;
      const bonus = ceoBonus(heldByOthers.get(p.uid) ?? 0, stock.price, cfg.bonusRate);
      if (bonus > 0) {
        p.cash += bonus;
        p.totalBonus += bonus;
        bonusOf.set(p.uid, bonus);
      }
    }
    const bonusesPaid = [...bonusOf.values()].reduce((a, b) => a + b, 0);

    // ---------- 4. Top up pool depth (§2.1) ----------
    const avgNetWorth = mean(earning().map(worthOf)) ?? cfg.baseStartingCash;
    const target = targetPoolCash(avgNetWorth, cfg.targetTradeSize, cfg.targetImpact);
    const toppedUp = new Map<string, number>();
    for (const s of stocks.values()) {
      const t = topUpPool(s, target);
      if (t.addCash > 0) {
        s.poolCash = t.newPoolCash;
        s.poolShares = t.newPoolShares;
        s.k = s.poolCash * s.poolShares;
        // Price is unchanged by construction; recompute to avoid drift.
        s.price = s.poolCash / s.poolShares;
        toppedUp.set(s.id, t.addCash);
      }
    }
    const poolTopUps = [...toppedUp.values()].reduce((a, b) => a + b, 0);

    // ---------- 5. Leaderboard + weekly prize winner ----------
    const growth: GrowthRow[] = [...players.values()].map((p) => {
      const end = worthOf(p);
      const allowance = allowanceOf.get(p.uid) ?? 0;
      return {
        uid: p.uid,
        name: p.displayName,
        netWorthStart: p.netWorthWeekStart,
        netWorthEnd: end,
        allowance,
        bonus: bonusOf.get(p.uid) ?? 0,
        weeklyGrowth: weeklyGrowth(p.netWorthWeekStart, end, allowance),
      };
    });
    growth.sort((a, b) => b.weeklyGrowth - a.weeklyGrowth);
    const eligible = growth.filter((g) => !players.get(g.uid)!.isIdle && g.netWorthStart > 0);
    const winnerRow = eligible[0] ?? null;

    // ---------- 6. Pay prize pool to winner, reset to 0 ----------
    const prizePoolBeforePayout = state.prizePool;
    let prizePaid = 0;
    if (winnerRow) {
      prizePaid = state.prizePool;
      players.get(winnerRow.uid)!.cash += prizePaid;
    }

    const leaderboard: LeaderboardRow[] = [...players.values()]
      .map((p) => ({
        uid: p.uid,
        name: p.displayName,
        score: leaderboardScore(worthOf(p), p.startingCash, p.totalAllowances),
        netWorth: worthOf(p),
        isIdle: p.isIdle,
      }))
      // Idle players are shown but not ranked: they sort after everyone active.
      .sort((a, b) => Number(a.isIdle) - Number(b.isIdle) || b.score - a.score);

    // ---------- 7. Report ----------
    const stockStats: StockWeekStats[] = [...stocks.values()]
      .map((s) => ({
        stockId: s.id,
        name: s.displayName,
        open: s.weekOpenPrice,
        close: s.price,
        high: s.weekHigh,
        low: s.weekLow,
        pctChange: s.weekOpenPrice > 0 ? s.price / s.weekOpenPrice - 1 : 0,
        tradeCount: s.weekTradeCount,
        poolCash: s.poolCash,
        toppedUpCash: toppedUp.get(s.id) ?? 0,
      }))
      .sort((a, b) => b.pctChange - a.pctChange);

    const moves: TradeMove[] = trades.map((t) => ({
      tradeId: t.id,
      traderName: t.traderName,
      stockName: t.stockName,
      side: t.side,
      cashAmount: t.cashAmount,
      movePct: t.priceAfter / t.priceBefore - 1,
    }));
    const largestMoves = [...moves].sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, 5);

    const allPlayers = [...players.values()];
    const totalCash = allPlayers.reduce((a, p) => a + p.cash, 0);
    const totalStockValue = allPlayers.reduce((a, p) => a + holdingsValueOf(p), 0);
    const totalNetWorth = totalCash + totalStockValue;
    const activeWorths = earning().map(worthOf);
    const wealthTop = activeWorths.length ? Math.max(...activeWorths) : 0;
    const wealthBottom = activeWorths.length ? Math.min(...activeWorths) : 0;
    const prices = stockStats.map((s) => s.close);
    const index = (mean([...stocks.values()].map((s) => s.price / s.listPrice)) ?? 1) * 100;
    const linkedTrades = trades.filter((t) => t.linkedPostId).length;

    const flags = computeFlags(cfg, stockStats, [...stocks.values()], world.holdings, trades, allPlayers);

    const summary: Record<string, number> = {
      totalCash,
      totalStockValue,
      totalNetWorth,
      allowancesPaid,
      bonusesPaid,
      feesCollected: state.weekFees,
      prizePool: prizePoolBeforePayout,
      medianPrice: median(prices) ?? 0,
      index,
      avgMovePerTrade: mean(moves.map((m) => Math.abs(m.movePct))) ?? 0,
      avgNetWorth,
      wealthGap: wealthTop - wealthBottom,
      activePlayers: activeWorths.length,
      tradeCount: trades.length,
      postCount: posts.length,
    };
    const changes: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(summary)) {
      const prev = prevReport?.summary?.[k];
      changes[k] = typeof prev === "number" ? v - prev : null;
    }

    const reportRef = refs.report(week);
    const reportBody: Omit<WeeklyReport, "markdown"> = {
      id: reportRef.id,
      week,
      periodStart: state.weekStartedAt,
      periodEnd: now,
      generatedAt: now,
      trigger: opts.trigger,
      settings: cfg,
      explainer: mechanicsExplainer(cfg),
      money: {
        totalCash,
        totalStockValue,
        totalNetWorth,
        allowancesPaid,
        bonusesPaid,
        poolTopUps,
        feesCollected: state.weekFees,
        prizePoolBeforePayout,
        prizePaid,
        cashPct: totalNetWorth > 0 ? totalCash / totalNetWorth : 0,
        stockPct: totalNetWorth > 0 ? totalStockValue / totalNetWorth : 0,
      },
      prices: { medianPrice: summary.medianPrice, index, stocks: stockStats },
      health: {
        avgMovePerTrade: summary.avgMovePerTrade,
        largestMoves,
        avgNetWorth,
        targetPoolCash: target,
        wealthTop,
        wealthBottom,
        wealthGap: wealthTop - wealthBottom,
      },
      activity: {
        totalPlayers: allPlayers.length,
        activePlayers: activeWorths.length,
        idlePlayers: allPlayers.length - activeWorths.length,
        newlyIdle,
        tradeCount: trades.length,
        postCount: posts.length,
        linkedTradePct: trades.length ? linkedTrades / trades.length : 0,
      },
      highlights: {
        leaderboard,
        growth,
        winner: winnerRow ? { uid: winnerRow.uid, name: winnerRow.name, weeklyGrowth: winnerRow.weeklyGrowth, prize: prizePaid } : null,
        biggestGainers: stockStats.filter((s) => s.pctChange > 0).slice(0, 3).map((s) => ({ name: s.name, pctChange: s.pctChange })),
        biggestLosers: [...stockStats].reverse().filter((s) => s.pctChange < 0).slice(0, 3).map((s) => ({ name: s.name, pctChange: s.pctChange })),
        topPosts: [...posts]
          .filter((p) => p.reactionCount > 0)
          .sort((a, b) => b.reactionCount - a.reactionCount)
          .slice(0, 3)
          .map((p) => ({ postId: p.id, authorName: p.authorName, text: p.text, reactionCount: p.reactionCount })),
      },
      flags,
      snapshot,
      summary,
      changes,
    };
    const report: WeeklyReport = { ...reportBody, markdown: reportToMarkdown(reportBody) };

    // ---------- Writes ----------
    for (const p of players.values()) {
      tx.update(refs.player(p.uid), {
        cash: p.cash,
        isIdle: p.isIdle,
        totalAllowances: p.totalAllowances,
        totalBonus: p.totalBonus,
        // Next week's baseline includes this week's payouts and prize.
        netWorthWeekStart: worthOf(p),
      });
    }
    for (const s of stocks.values()) {
      tx.update(refs.stock(s.id), {
        poolCash: s.poolCash,
        poolShares: s.poolShares,
        k: s.k,
        price: s.price,
        weekOpenPrice: s.price,
        weekHigh: s.price,
        weekLow: s.price,
        weekTradeCount: 0,
      });
    }
    tx.set(refs.state(), {
      currentWeek: week + 1,
      prizePool: state.prizePool - prizePaid,
      weekFees: 0,
      weekStartedAt: now,
      lastCloseAt: now,
    });
    tx.set(reportRef, report);

    const postRef = db.collection("posts").doc();
    const winnerText = winnerRow
      ? `${winnerRow.name} wins the £${prizePaid.toFixed(2)} prize pool with ${(winnerRow.weeklyGrowth * 100).toFixed(2)}% weekly growth.`
      : "No eligible winner; the prize pool rolls over.";
    const sysPost: Post = {
      id: postRef.id,
      authorId: "system",
      authorName: "Market",
      taggedStockId: null,
      taggedName: null,
      text: `Week ${week} closed. ${winnerText}`,
      linkedTradeId: null,
      linkedTradeSummary: null,
      reactions: {},
      reactionCount: 0,
      system: true,
      week: week + 1,
      createdAt: now,
    };
    tx.set(postRef, sysPost);
    tx.set(auditRef(), auditEntry(opts.actorId ?? "cron", "weeklyClose", reportRef.id, { week, trigger: opts.trigger, prizePaid }, now));

    return { closed: true, week, reportId: reportRef.id, winner: winnerRow?.name ?? null, prize: prizePaid };
  });
}

function computeFlags(
  cfg: { flagMovePct: number; flagOwnershipPct: number; flagCollusionMinTrades: number },
  stats: StockWeekStats[],
  stocks: Stock[],
  holdings: { uid: string; stockId: string; shares: number }[],
  trades: Trade[],
  players: Player[],
): ReportFlag[] {
  const flags: ReportFlag[] = [];
  const nameOf = new Map(players.map((p) => [p.uid, p.displayName]));

  for (const s of stats) {
    if (Math.abs(s.pctChange) > cfg.flagMovePct) {
      flags.push({ type: "bigMove", message: `${s.name} moved ${(s.pctChange * 100).toFixed(1)}% this week.` });
    }
  }

  // Concentration: one player holds most of a stock's player-held shares.
  for (const s of stocks) {
    const hs = holdings.filter((h) => h.stockId === s.id && h.shares > 0);
    const total = hs.reduce((a, h) => a + h.shares, 0);
    // Ignore dust positions (under 1% of pool depth by value).
    if (total * s.price < 0.01 * s.poolCash) continue;
    const top = hs.reduce((best, h) => (h.shares > (best?.shares ?? 0) ? h : best), hs[0]);
    if (top && top.shares / total > cfg.flagOwnershipPct) {
      flags.push({
        type: "concentration",
        message: `${nameOf.get(top.uid) ?? top.uid} holds ${((top.shares / total) * 100).toFixed(0)}% of player-held ${s.displayName} shares.`,
      });
    }
  }

  // Possible collusion: two players repeatedly trading each other's stock.
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(`${t.traderId}>${t.stockId}`, (counts.get(`${t.traderId}>${t.stockId}`) ?? 0) + 1);
  const seen = new Set<string>();
  for (const key of counts.keys()) {
    const [a, b] = key.split(">");
    const pair = [a, b].sort().join("|");
    if (seen.has(pair)) continue;
    seen.add(pair);
    const ab = counts.get(`${a}>${b}`) ?? 0;
    const ba = counts.get(`${b}>${a}`) ?? 0;
    if (ab >= cfg.flagCollusionMinTrades && ba >= cfg.flagCollusionMinTrades) {
      flags.push({
        type: "collusion",
        message: `${nameOf.get(a) ?? a} and ${nameOf.get(b) ?? b} traded each other's stock back and forth (${ab} / ${ba} trades).`,
      });
    }
  }
  return flags;
}
