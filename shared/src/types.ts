/**
 * Firestore document shapes. Timestamps are stored as epoch milliseconds
 * (numbers) so the same types work on server, client and in reports.
 */

export interface GameConfig {
  /** Founder starting cash (§4.1). */
  baseStartingCash: number;
  /** Listing price for the very first stocks (§4.2). */
  baseStockPrice: number;
  /** Flat weekly cash per active (non-idle) player (§3). */
  weeklyAllowance: number;
  /** Fee per trade as a fraction, e.g. 0.015 = 1.5%. Funds the prize pool. */
  tradingFeePct: number;
  /** CEO bonus rate on value of your stock held by others, e.g. 0.01 = 1%. */
  bonusRate: number;
  /** Trade size used to size pools, as a fraction of average net worth. */
  targetTradeSize: number;
  /** Price move a targetTradeSize buy should cause, e.g. 0.05 = 5%. */
  targetImpact: number;
  /** Weeks without login/trade before a player is flagged idle. */
  idleThresholdWeeks: number;
  /** Report flag: stock weekly move above this fraction. */
  flagMovePct: number;
  /** Report flag: one player owns more than this fraction of a stock's player-held shares. */
  flagOwnershipPct: number;
  /** Report flag: min trades each way between two players to flag possible collusion. */
  flagCollusionMinTrades: number;
  /** Automated (cron) weekly close is skipped if the last close was more recent than this. */
  minHoursBetweenAutoCloses: number;
  /** Max post length in characters. */
  maxPostLength: number;
}

export interface GameState {
  /** Current week number, starting at 1. */
  currentWeek: number;
  /** Accumulated trading fees, paid to the weekly winner. */
  prizePool: number;
  /** Fees collected during the current week (for reports). */
  weekFees: number;
  weekStartedAt: number;
  lastCloseAt: number | null;
}

export interface Player {
  uid: string;
  displayName: string;
  cash: number;
  joinWeek: number;
  /** False once an admin delists the player. */
  isActive: boolean;
  isIdle: boolean;
  lastActiveAt: number;
  createdAt: number;
  startingCash: number;
  /** Σ weekly allowances received (leaderboard denominator). */
  totalAllowances: number;
  /** Σ CEO bonuses received (counted in net worth, not in denominator). */
  totalBonus: number;
  /** Net worth snapshot at the start of the current week (weekly prize). */
  netWorthWeekStart: number;
}

export interface Stock {
  /** Same as ownerId. */
  id: string;
  ownerId: string;
  displayName: string;
  price: number;
  poolCash: number;
  poolShares: number;
  k: number;
  listed: boolean;
  listPrice: number;
  listedAt: number;
  listedWeek: number;
  /** Rolling stats for the current week, reset at weekly close. */
  weekOpenPrice: number;
  weekHigh: number;
  weekLow: number;
  weekTradeCount: number;
  delistedAt?: number;
}

/** Stored at holdings/{uid}_{stockId}. */
export interface Holding {
  uid: string;
  stockId: string;
  shares: number;
  updatedAt: number;
}

export type TradeSide = "buy" | "sell";

export interface Trade {
  id: string;
  traderId: string;
  traderName: string;
  stockId: string;
  stockName: string;
  side: TradeSide;
  /** Gross cash: amount spent (buy, incl. fee) or pool payout before fee (sell). */
  cashAmount: number;
  /** Net cash that hit the player's wallet (negative for buys). */
  netCash: number;
  shares: number;
  fee: number;
  priceBefore: number;
  priceAfter: number;
  week: number;
  createdAt: number;
  linkedPostId?: string | null;
}

export type ReactionType = "like" | "laugh" | "wow" | "down";
export const REACTION_TYPES: ReactionType[] = ["like", "laugh", "wow", "down"];
export const REACTION_EMOJI: Record<ReactionType, string> = {
  like: "👍",
  laugh: "😂",
  wow: "😮",
  down: "👎",
};

export interface Post {
  id: string;
  authorId: string;
  authorName: string;
  taggedStockId: string | null;
  taggedName: string | null;
  text: string;
  linkedTradeId: string | null;
  /** Denormalised trade summary for display, e.g. "bought 10.00 shares of James". */
  linkedTradeSummary: string | null;
  /** reactionType -> list of uids. Purely social: never affects price. */
  reactions: Partial<Record<ReactionType, string[]>>;
  reactionCount: number;
  /** System posts (weekly close, delist) have authorId "system". */
  system: boolean;
  week: number;
  createdAt: number;
}

export type RegistrationStatus = "pending" | "approved" | "rejected";

export interface Registration {
  uid: string;
  displayName: string;
  email: string | null;
  status: RegistrationStatus;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface AuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: number;
}
