/**
 * Firestore document shapes. Timestamps are stored as epoch milliseconds
 * (numbers) so the same types work on server, client and in reports.
 */
import type { DiscordMessage } from "./discord";

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
  /** Minimum seconds between a player's standalone posts. 0 disables the cooldown. */
  postCooldownSeconds: number;
  /** Max total short exposure (value of open shorts) as a fraction of a player's capital. */
  maxShortExposurePct: number;
  /** Weekly borrow fee on the value of each open short, charged at weekly close into the prize pool. */
  shortBorrowFeePct: number;
  /**
   * Weekly prize split by weekly-growth rank, e.g. [0.6, 0.25, 0.15] pays 1st/2nd/3rd.
   * The entries actually used are renormalised to sum to 1, so fewer eligible
   * players than entries still drains the whole pool.
   */
  prizeSplitPct: number[];
  /** Minimum hours between a player's ticker changes. 0 disables the cooldown. */
  tickerChangeCooldownHours: number;
  /** 1 = post to the Discord webhook (when its secret is set), 0 = off. */
  discordEnabled: number;
  /** Discord: a trade or short at least this fraction of average net worth is "big" and gets posted. */
  discordBigTradePct: number;
  /** Discord: max routine posts per hour before the rest roll into an hourly digest. 0 = digest everything routine. */
  discordMaxPerHour: number;
  /** Show the "while you were away" recap after this many hours without activity. */
  recapAfterHours: number;
  /** Max active price alerts per player. */
  maxActiveAlerts: number;
}

export interface GameState {
  /** Current week number, starting at 1. */
  currentWeek: number;
  /** Accumulated trading fees, split among the weekly prize winners. */
  prizePool: number;
  /** Fees collected during the current week (for reports). */
  weekFees: number;
  weekStartedAt: number;
  lastCloseAt: number | null;
  /** Average net worth of active players at the last close or listing (Discord "big trade" threshold). */
  avgNetWorth?: number;
}

/** What a player looked like the last time they opened the app (drives the recap and moments). */
export interface SeenSnapshot {
  at: number;
  netWorth: number;
  /** Leaderboard rank, or null when idle/unranked. */
  rank: number | null;
  week: number;
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
  /** When the player last created a standalone post (post cooldown, §spam). Absent for players who haven't posted. */
  lastPostAt?: number;
  /** Set when the player was deactivated by the bankruptcy rule. Cleared at the next weekly close. */
  bankruptAt?: number;
  /** Discord user ID (a numeric "snowflake") so Discord posts can @mention them. */
  discordId?: string;
  /** Written by `touch` each session. */
  seenSnapshot?: SeenSnapshot;
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
  /**
   * 2–5 letter ticker the owner picked (or was given at listing). Absent on
   * stocks listed before tickers existed; use `assignTickers` to read it.
   */
  ticker?: string;
  /** When the owner last changed their ticker (cooldown). */
  tickerChangedAt?: number;
  /** The last RECENT_PRICES_MAX prices after each trade, oldest first (feed sparklines). */
  recentPrices?: number[];
  /** Highest / lowest price ever traded. Absent until the first trade after this field was added. */
  allTimeHigh?: number;
  allTimeLow?: number;
  /** Week a new all-time high/low was last announced (at most one each per week). */
  athAnnouncedWeek?: number;
  atlAnnouncedWeek?: number;
}

/** Stored at holdings/{uid}_{stockId}. */
export interface Holding {
  uid: string;
  stockId: string;
  shares: number;
  updatedAt: number;
  /** Average-cost basis of the shares held (cash spent incl. fees). Absent on pre-awards holdings until backfilled. */
  costBasis?: number;
  /** When the current unbroken run of holding began: the first buy, reset by any sell (Diamond Hands). */
  holdingSince?: number;
}

export type TradeSide = "buy" | "sell";

export type ShortStatus = "open" | "closed";

/**
 * A synthetic short position (stored at shorts/{id}). Opening sells `shares`
 * into the pool for `openProceeds` (net of fee); closing buys them back. No
 * share inventory is borrowed — it's purely the AMM, so price impact and fees
 * fall on the short-seller exactly like a sell then a buy.
 */
export interface Short {
  id: string;
  ownerId: string;
  ownerName: string;
  stockId: string;
  stockName: string;
  shares: number;
  status: ShortStatus;
  /** Price when opened, and cash received (net of the opening fee). */
  openPrice: number;
  openProceeds: number;
  openedAt: number;
  openWeek: number;
  /** Σ weekly borrow fees charged while open. */
  borrowFeesPaid: number;
  /** Set when closed. */
  closePrice?: number;
  /** Cash paid to buy the shares back (incl. the closing fee). */
  closeCost?: number;
  /** openProceeds − closeCost − borrowFeesPaid. */
  realisedPnl?: number;
  closedAt?: number;
  closeWeek?: number;
}

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
  /** Present when this trade opened or closed a short, so the feed can label it. */
  kind?: "openShort" | "closeShort";
  /** The stock's recent prices up to and including priceAfter, for the feed card's sparkline. */
  recentPrices?: number[];
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

/** A single net-worth sample. */
export interface NetWorthPoint {
  /** Week number this sample is the close of. */
  week: number;
  /** Epoch ms when recorded. */
  t: number;
  /** Net worth at that moment. */
  v: number;
}

/**
 * Stored at netWorthHistory/{uid}. One point appended per weekly close, so a
 * player's net worth can be charted over time. Kept out of the player doc so
 * live reads stay small; capped to the most recent NET_WORTH_HISTORY_MAX points.
 */
export interface NetWorthHistory {
  uid: string;
  points: NetWorthPoint[];
}

/** Stored at photos/{uid}. Kept out of stocks/{uid} so price updates don't resend image data. */
export interface StockPhoto {
  uid: string;
  dataUrl: string;
  updatedAt: number;
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

export type AlertDirection = "above" | "below";
export type AlertStatus = "active" | "triggered" | "cancelled";

/** Stored at alerts/{id}. Readable only by its owner. */
export interface PriceAlert {
  id: string;
  uid: string;
  stockId: string;
  stockName: string;
  direction: AlertDirection;
  /** Target price in £. */
  price: number;
  /** Also @mention the owner on Discord when it fires (needs a linked Discord ID). */
  discord: boolean;
  status: AlertStatus;
  createdAt: number;
  triggeredAt?: number;
  triggeredPrice?: number;
}

/** Stored at notifications/{id}. In-app messages for one player; readable only by them. */
export interface AppNotification {
  id: string;
  uid: string;
  kind: "alert";
  title: string;
  body: string;
  stockId: string | null;
  createdAt: number;
  read: boolean;
}

/** Stored at discordOutbox/{id}. Server-only (no client access). */
export interface DiscordOutboxItem {
  id: string;
  /** "high" posts immediately; "normal" is rate-limited and may be rolled into a digest. */
  priority: "high" | "normal";
  kind: string;
  message: DiscordMessage;
  status: "pending" | "sent" | "queued" | "digested" | "failed" | "skipped";
  createdAt: number;
  sentAt?: number;
  error?: string;
}
