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
};

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
  label: string;
  help: string;
}

/** Validation bounds + labels, used by the admin UI and the updateConfig function. */
export const CONFIG_BOUNDS: Record<keyof GameConfig, Bound> = {
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
};

export function mergeConfig(stored: Partial<GameConfig> | undefined | null): GameConfig {
  const out: GameConfig = { ...DEFAULT_CONFIG };
  if (!stored) return out;
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GameConfig)[]) {
    const v = stored[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** Returns a list of human-readable errors; empty when valid. Unknown keys are rejected. */
export function validateConfigPatch(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const bound = CONFIG_BOUNDS[key as keyof GameConfig];
    if (!bound) {
      errors.push(`Unknown setting: ${key}`);
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
