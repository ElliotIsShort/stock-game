import type { GameConfig } from "./types";

export interface StockWeekStats {
  stockId: string;
  name: string;
  open: number;
  close: number;
  high: number;
  low: number;
  pctChange: number;
  tradeCount: number;
  poolCash: number;
  toppedUpCash: number;
}

export interface TradeMove {
  tradeId: string;
  traderName: string;
  stockName: string;
  side: "buy" | "sell";
  cashAmount: number;
  movePct: number;
}

export interface PlayerSnapshot {
  uid: string;
  name: string;
  cash: number;
  holdingsValue: number;
  netWorth: number;
  isIdle: boolean;
}

export interface LeaderboardRow {
  uid: string;
  name: string;
  score: number;
  netWorth: number;
  isIdle: boolean;
}

export interface GrowthRow {
  uid: string;
  name: string;
  netWorthStart: number;
  netWorthEnd: number;
  allowance: number;
  bonus: number;
  weeklyGrowth: number;
}

export interface ReportFlag {
  type: "bigMove" | "concentration" | "collusion";
  message: string;
}

export interface WeeklyReport {
  id: string;
  week: number;
  periodStart: number;
  periodEnd: number;
  generatedAt: number;
  trigger: "admin" | "cron";
  settings: GameConfig;
  explainer: string;
  money: {
    totalCash: number;
    totalStockValue: number;
    totalNetWorth: number;
    allowancesPaid: number;
    bonusesPaid: number;
    poolTopUps: number;
    feesCollected: number;
    prizePoolBeforePayout: number;
    prizePaid: number;
    cashPct: number;
    stockPct: number;
  };
  prices: {
    medianPrice: number;
    /** Equal-weighted index of price / listing price, base 100. */
    index: number;
    stocks: StockWeekStats[];
  };
  health: {
    avgMovePerTrade: number;
    largestMoves: TradeMove[];
    avgNetWorth: number;
    targetPoolCash: number;
    wealthTop: number;
    wealthBottom: number;
    wealthGap: number;
  };
  activity: {
    totalPlayers: number;
    activePlayers: number;
    idlePlayers: number;
    newlyIdle: string[];
    tradeCount: number;
    postCount: number;
    linkedTradePct: number;
  };
  highlights: {
    leaderboard: LeaderboardRow[];
    growth: GrowthRow[];
    winner: { uid: string; name: string; weeklyGrowth: number; prize: number } | null;
    biggestGainers: { name: string; pctChange: number }[];
    biggestLosers: { name: string; pctChange: number }[];
    topPosts: { postId: string; authorName: string; text: string; reactionCount: number }[];
  };
  flags: ReportFlag[];
  /** Balances snapshotted before any weekly payouts. */
  snapshot: PlayerSnapshot[];
  /** Flat headline metrics, used to compute week-over-week changes. */
  summary: Record<string, number>;
  /** summary[key] − previous report's summary[key]; null when no prior week. */
  changes: Record<string, number | null>;
  markdown: string;
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function mechanicsExplainer(cfg: GameConfig): string {
  return [
    "Friend Stock Market is a play-money game for a friend group. Every player is both a trader and a listed stock named after them.",
    "Players trade each other's stock (never their own) against an automated market maker: each stock has a pool of cash C and shares S, price = C / S, and C × S stays constant during a trade. Buying adds cash to the pool and removes shares (price rises); selling does the reverse (price falls). Bigger trades move the price proportionally more. Fractional shares are allowed.",
    `Every trade pays a ${pct(cfg.tradingFeePct)} fee into a prize pool. At weekly close the whole prize pool goes to the player with the highest weekly growth, computed as (net worth at close − net worth at week start − that week's allowance) / net worth at week start.`,
    `Prices move only through trades. Posts and reactions in the feed never move prices directly; players decide whether a post is worth trading on, and stories may be made up.`,
    `Money in: founders start with ${gbp(cfg.baseStartingCash)}; later joiners start with that plus ${gbp(cfg.weeklyAllowance)} per week already elapsed. Each active player gets a ${gbp(cfg.weeklyAllowance)} weekly allowance and a CEO bonus of ${pct(cfg.bonusRate)} of the value of their stock held by other players. Money out: trading fees (recycled to the winner).`,
    `Pool depth tracks wealth: pools are sized so a trade of ${pct(cfg.targetTradeSize)} of average net worth moves price by about ${pct(cfg.targetImpact)}. Each week, any pool below that target is topped up with cash and shares at the current price (price unchanged). Pools are never shrunk.`,
    `First stocks listed at ${gbp(cfg.baseStockPrice)}; later stocks list at the median current price. Players inactive for ${cfg.idleThresholdWeeks} weeks become idle: no allowance or bonus, excluded from average net worth and leaderboard ranking; their stock stays tradable. They reactivate on next login or trade.`,
    "Leaderboard score = net worth / (starting cash + allowances received). Everyone starts at 1.00.",
  ].join("\n\n");
}

function change(changes: Record<string, number | null>, key: string, fmt: (n: number) => string): string {
  const c = changes[key];
  if (c === null || c === undefined) return "";
  const sign = c > 0 ? "+" : c < 0 ? "−" : "±";
  return ` (${sign}${fmt(Math.abs(c))} vs prior week)`;
}

export function reportToMarkdown(r: Omit<WeeklyReport, "markdown">): string {
  const c = r.changes;
  const lines: string[] = [];
  lines.push(`# Friend Stock Market — Week ${r.week} report`);
  lines.push(`Period: ${new Date(r.periodStart).toISOString()} → ${new Date(r.periodEnd).toISOString()} (trigger: ${r.trigger})`);
  lines.push("");
  lines.push("## How the game works");
  lines.push(r.explainer);
  lines.push("");
  lines.push("## Settings snapshot");
  const s = r.settings;
  lines.push(`- Weekly allowance: ${gbp(s.weeklyAllowance)}`);
  lines.push(`- Trading fee: ${pct(s.tradingFeePct)}`);
  lines.push(`- CEO bonus rate: ${pct(s.bonusRate)}`);
  lines.push(`- Pool depth target: ${pct(s.targetTradeSize)} of avg net worth moves price ${pct(s.targetImpact)} (target pool cash now ${gbp(r.health.targetPoolCash)})`);
  lines.push(`- Base starting cash ${gbp(s.baseStartingCash)}, base stock price ${gbp(s.baseStockPrice)}, idle after ${s.idleThresholdWeeks} weeks`);
  lines.push("");
  lines.push("## Money");
  const m = r.money;
  lines.push(`- Total cash: ${gbp(m.totalCash)}${change(c, "totalCash", gbp)}`);
  lines.push(`- Total stock value (holdings at spot): ${gbp(m.totalStockValue)}${change(c, "totalStockValue", gbp)}`);
  lines.push(`- Total net worth: ${gbp(m.totalNetWorth)}${change(c, "totalNetWorth", gbp)}`);
  lines.push(`- Cash vs stock: ${pct(m.cashPct)} / ${pct(m.stockPct)}`);
  lines.push(`- Money in: allowances ${gbp(m.allowancesPaid)}${change(c, "allowancesPaid", gbp)}, CEO bonuses ${gbp(m.bonusesPaid)}${change(c, "bonusesPaid", gbp)}`);
  lines.push(`- Money out: fees ${gbp(m.feesCollected)}${change(c, "feesCollected", gbp)}`);
  lines.push(`- Pool top-ups (new liquidity): ${gbp(m.poolTopUps)}`);
  lines.push(`- Prize pool: ${gbp(m.prizePoolBeforePayout)}${change(c, "prizePool", gbp)}, paid ${gbp(m.prizePaid)}`);
  lines.push("");
  lines.push("## Prices");
  lines.push(`- Median price: ${gbp(r.prices.medianPrice)}${change(c, "medianPrice", gbp)}`);
  lines.push(`- Market index (base 100): ${r.prices.index.toFixed(2)}${change(c, "index", (n) => n.toFixed(2))}`);
  lines.push("");
  lines.push("| Stock | Open | Close | High | Low | % change | Trades |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const st of r.prices.stocks) {
    lines.push(`| ${st.name} | ${gbp(st.open)} | ${gbp(st.close)} | ${gbp(st.high)} | ${gbp(st.low)} | ${pct(st.pctChange)} | ${st.tradeCount} |`);
  }
  lines.push("");
  lines.push("## Market health");
  const h = r.health;
  lines.push(`- Average price move per trade: ${pct(h.avgMovePerTrade)}${change(c, "avgMovePerTrade", pct)}`);
  lines.push(`- Average net worth (active players): ${gbp(h.avgNetWorth)}${change(c, "avgNetWorth", gbp)}`);
  lines.push(`- Wealth gap: top ${gbp(h.wealthTop)}, bottom ${gbp(h.wealthBottom)}, gap ${gbp(h.wealthGap)}${change(c, "wealthGap", gbp)}`);
  if (h.largestMoves.length) {
    lines.push("- Largest single-trade moves:");
    for (const t of h.largestMoves) {
      lines.push(`  - ${t.traderName} ${t.side === "buy" ? "bought" : "sold"} ${gbp(t.cashAmount)} of ${t.stockName}: ${pct(t.movePct)}`);
    }
  }
  lines.push("");
  lines.push("## Activity");
  const a = r.activity;
  lines.push(`- Players: ${a.totalPlayers} total, ${a.activePlayers} active${change(c, "activePlayers", String)}, ${a.idlePlayers} idle`);
  if (a.newlyIdle.length) lines.push(`- Newly idle: ${a.newlyIdle.join(", ")}`);
  lines.push(`- Trades: ${a.tradeCount}${change(c, "tradeCount", String)}`);
  lines.push(`- Posts: ${a.postCount}${change(c, "postCount", String)}`);
  lines.push(`- Trades linked to a post: ${pct(a.linkedTradePct)}`);
  lines.push("");
  lines.push("## Highlights");
  const hl = r.highlights;
  lines.push(hl.winner ? `- Weekly prize: **${hl.winner.name}** with ${pct(hl.winner.weeklyGrowth)} growth, won ${gbp(hl.winner.prize)}` : "- Weekly prize: no eligible winner");
  lines.push("- Leaderboard:");
  hl.leaderboard.forEach((row, i) => {
    lines.push(`  ${i + 1}. ${row.name}${row.isIdle ? " (idle)" : ""}: score ${row.score.toFixed(3)}, net worth ${gbp(row.netWorth)}`);
  });
  if (hl.biggestGainers.length) lines.push(`- Biggest gainers: ${hl.biggestGainers.map((g) => `${g.name} ${pct(g.pctChange)}`).join(", ")}`);
  if (hl.biggestLosers.length) lines.push(`- Biggest losers: ${hl.biggestLosers.map((g) => `${g.name} ${pct(g.pctChange)}`).join(", ")}`);
  if (hl.topPosts.length) {
    lines.push("- Most-reacted posts:");
    for (const p of hl.topPosts) lines.push(`  - ${p.authorName} (${p.reactionCount} reactions): "${p.text.replace(/\s+/g, " ").slice(0, 200)}"`);
  }
  lines.push("");
  lines.push("## Flags");
  if (r.flags.length === 0) lines.push("- None");
  for (const f of r.flags) lines.push(`- [${f.type}] ${f.message}`);
  return lines.join("\n");
}
