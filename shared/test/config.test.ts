import { describe, expect, it } from "vitest";
import { CONFIG_BOUNDS, DEFAULT_CONFIG, mergeConfig, validateConfigPatch } from "../src/config";

describe("config", () => {
  it("defaults all pass their own validation", () => {
    expect(validateConfigPatch({ ...DEFAULT_CONFIG })).toEqual([]);
  });

  it("every setting has bounds and a label", () => {
    expect(Object.keys(CONFIG_BOUNDS).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
  });

  it("rejects unknown keys, non-numbers, out-of-range and non-integer values", () => {
    expect(validateConfigPatch({ nope: 1 })).toEqual(["Unknown setting: nope"]);
    expect(validateConfigPatch({ tradingFeePct: "0.1" })).toHaveLength(1);
    expect(validateConfigPatch({ tradingFeePct: 5 })).toHaveLength(1);
    expect(validateConfigPatch({ idleThresholdWeeks: 2.5 })).toHaveLength(1);
    expect(validateConfigPatch({ weeklyAllowance: Number.POSITIVE_INFINITY })).toHaveLength(1);
  });

  it("mergeConfig fills gaps with defaults and ignores junk", () => {
    const merged = mergeConfig({ weeklyAllowance: 300, tradingFeePct: Number.NaN } as never);
    expect(merged.weeklyAllowance).toBe(300);
    expect(merged.tradingFeePct).toBe(DEFAULT_CONFIG.tradingFeePct);
    expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
  });
});
