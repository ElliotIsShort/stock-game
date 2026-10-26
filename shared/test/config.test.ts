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

  it("defaults the prize split to 60/25/15", () => {
    expect(DEFAULT_CONFIG.prizeSplitPct).toEqual([0.6, 0.25, 0.15]);
  });

  it("accepts a prize split of non-negative numbers", () => {
    expect(validateConfigPatch({ prizeSplitPct: [1] })).toEqual([]);
    expect(validateConfigPatch({ prizeSplitPct: [0.5, 0.3, 0.2, 0] })).toEqual([]);
    expect(validateConfigPatch({ prizeSplitPct: [3, 2, 1] })).toEqual([]);
  });

  it("rejects bad prize splits", () => {
    expect(validateConfigPatch({ prizeSplitPct: 0.6 })).toHaveLength(1);
    expect(validateConfigPatch({ prizeSplitPct: [] })).toHaveLength(1);
    expect(validateConfigPatch({ prizeSplitPct: new Array(11).fill(0.1) })).toHaveLength(1);
    expect(validateConfigPatch({ prizeSplitPct: [0.6, -0.1] })).toHaveLength(1);
    expect(validateConfigPatch({ prizeSplitPct: [0.6, "0.4"] })).toHaveLength(1);
    expect(validateConfigPatch({ prizeSplitPct: [0.6, null] })).toHaveLength(1);
    expect(validateConfigPatch({ prizeSplitPct: [0.6, Number.NaN] })).toHaveLength(1);
    // First place must get something, or a single eligible player would have nothing to rescale.
    expect(validateConfigPatch({ prizeSplitPct: [0, 1] })).toHaveLength(1);
  });

  it("mergeConfig keeps a valid stored split, ignores an invalid one, and never shares the default array", () => {
    expect(mergeConfig({ prizeSplitPct: [0.7, 0.3] }).prizeSplitPct).toEqual([0.7, 0.3]);
    expect(mergeConfig({ prizeSplitPct: [-1] }).prizeSplitPct).toEqual(DEFAULT_CONFIG.prizeSplitPct);
    expect(mergeConfig({ prizeSplitPct: "junk" } as never).prizeSplitPct).toEqual(DEFAULT_CONFIG.prizeSplitPct);
    expect(mergeConfig(null).prizeSplitPct).not.toBe(DEFAULT_CONFIG.prizeSplitPct);
  });
});
