import type { GameConfig } from "./types";

/** Defaults from §9 of the design doc. Every value is overridable via config/global. */
export const DEFAULT_CONFIG: GameConfig = {
  baseStartingCash: 1000,
  baseStockPrice: 50,
  weeklyAllowance: 200,
  tradingFeePct: 0.015,
  bonusRate: 0.01,
  targetTradeSize: 0.1,
  targetImpact: 0.05,
  idleThresholdWeeks: 4,
  flagMovePct: 0.5,
  flagOwnershipPct: 0.5,
  flagCollusionMinTrades: 3,
  minHoursBetweenAutoCloses: 144,
  maxPostLength: 500,
  postCooldownSeconds: 10,
  maxShortExposurePct: 0.5,
  shortBorrowFeePct: 0.02,
  prizeSplitPct: [0.6, 0.25, 0.15],
  tickerChangeCooldownHours: 24,
};

export interface NumberBound {
  kind?: "number";
  min: number;
  max: number;
  integer?: boolean;
  label: string;
  help: string;
}

/** A list of non-negative numbers (e.g. the prize split). The first entry must be positive. */
export interface ListBound {
  kind: "list";
  minLength: number;
  maxLength: number;
  label: string;
  help: string;
}

export type Bound = NumberBound | ListBound;

type ConfigBounds = { [K in keyof GameConfig]: GameConfig[K] extends number[] ? ListBound : NumberBound };

/** Validation bounds + labels, used by the admin UI and the updateConfig function. */
export const CONFIG_BOUNDS: ConfigBounds = {
  baseStartingCash: { min: 0, max: 1e9, label: "Base starting cash (£)", help: "Founder starting cash" },
  baseStockPrice: { min: 0.01, max: 1e6, label: "Base stock price (£)", help: "Listing price for the first stocks" },
  weeklyAllowance: { min: 0, max: 1e9, label: "Weekly allowance (£)", help: "Flat weekly cash per active player" },
  tradingFeePct: { min: 0, max: 0.2, label: "Trading fee (fraction)", help: "0.015 = 1.5%, funds the prize pool" },
  bonusRate: { min: 0, max: 0.5, label: "CEO bonus rate (fraction)", help: "Weekly bonus on value of your stock held by others" },
  targetTradeSize: { min: 0.001, max: 1, label: "Target trade size (fraction of avg net worth)", help: "Trade size used to size pools" },
  targetImpact: { min: 0.001, max: 5, label: "Target impact (fraction)", help: "Price move that target trade should cause" },
  idleThresholdWeeks: { min: 1, max: 520, integer: true, label: "Idle threshold (weeks)", help: "Weeks of no activity before idle" },
  flagMovePct: { min: 0, max: 100, label: "Flag: weekly move (fraction)", help: "Report flags stocks moving more than this" },
  flagOwnershipPct: { min: 0, max: 1, label: "Flag: ownership (fraction)", help: "Report flags one player owning more than this share of a stock" },
  flagCollusionMinTrades: { min: 1, max: 1000, integer: true, label: "Flag: back-and-forth trades", help: "Min trades each way between two players to flag" },
  minHoursBetweenAutoCloses: { min: 0, max: 1000, label: "Min hours between automatic closes", help: "Cron-triggered closes are skipped inside this window" },
  maxPostLength: { min: 10, max: 5000, integer: true, label: "Max post length", help: "Characters" },
  postCooldownSeconds: { min: 0, max: 3600, integer: true, label: "Post cooldown (seconds)", help: "Minimum seconds between a player's posts; 0 disables it" },
  maxShortExposurePct: { min: 0, max: 5, label: "Max short exposure (fraction of capital)", help: "0.5 = you can short up to half your capital" },
  shortBorrowFeePct: { min: 0, max: 0.5, label: "Weekly short borrow fee (fraction)", help: "0.02 = 2% of each open short's value per week" },
  prizeSplitPct: {
    kind: "list",
    minLength: 1,
    maxLength: 10,
    label: "Weekly prize split (1st, 2nd, 3rd…)",
    help: "Comma-separated, e.g. 0.6, 0.25, 0.15. Rescaled to 100% across however many players qualify.",
  },
  tickerChangeCooldownHours: { min: 0, max: 8760, label: "Ticker change cooldown (hours)", help: "Minimum hours between a player's ticker changes; 0 disables it" },
};

function listErrors(key: string, value: unknown, bound: ListBound): string[] {
  if (!Array.isArray(value)) return [`${key} must be a list of numbers`];
  if (value.length < bound.minLength || value.length > bound.maxLength) {
    return [`${key} must have between ${bound.minLength} and ${bound.maxLength} entries`];
  }
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return [`${key} entries must be non-negative numbers`];
  // A zero first entry would leave nothing to renormalise when only one player qualifies.
  if (value[0] <= 0) return [`${key} first entry must be greater than 0`];
  return [];
}

export function mergeConfig(stored: Partial<GameConfig> | undefined | null): GameConfig {
  const out: GameConfig = { ...DEFAULT_CONFIG, prizeSplitPct: [...DEFAULT_CONFIG.prizeSplitPct] };
  if (!stored) return out;
  const writable = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GameConfig)[]) {
    const v = stored[key];
    const bound: Bound = CONFIG_BOUNDS[key];
    if (bound.kind === "list") {
      if (listErrors(key, v, bound).length === 0) writable[key] = [...(v as number[])];
    } else if (typeof v === "number" && Number.isFinite(v)) {
      writable[key] = v;
    }
  }
  return out;
}

/** Returns a list of human-readable errors; empty when valid. Unknown keys are rejected. */
export function validateConfigPatch(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const bound: Bound | undefined = CONFIG_BOUNDS[key as keyof GameConfig];
    if (!bound) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    if (bound.kind === "list") {
      errors.push(...listErrors(key, value, bound));
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${key} must be a number`);
      continue;
    }
    if (value < bound.min || value > bound.max) errors.push(`${key} must be between ${bound.min} and ${bound.max}`);
    if (bound.integer && !Number.isInteger(value)) errors.push(`${key} must be a whole number`);
  }
  return errors;
}
