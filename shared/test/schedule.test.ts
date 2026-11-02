import { describe, expect, it } from "vitest";
import {
  CLOSE_WEEK_MS,
  advanceClosesAt,
  closeSlotAtOrBefore,
  closeTimeError,
  effectiveClosesAt,
  formatCloseTime,
  formatCountdown,
  legacyClosesAt,
  nextScheduledClose,
} from "../src/schedule";

const H = 3_600_000;
const MIN = 60_000;
// Wednesday 28 Oct 2026, 12:00 UTC. The surrounding Sunday 20:00 UTC slots:
const WED = Date.UTC(2026, 9, 28, 12);
const LAST_SUN = Date.UTC(2026, 9, 25, 20);
const NEXT_SUN = Date.UTC(2026, 10, 1, 20);

describe("advancing the close by whole weeks", () => {
  it("adds exactly seven days to the previous close, not to now", () => {
    // The scheduler runs a minute late: the next close keeps Sunday 20:00.
    expect(advanceClosesAt(LAST_SUN, LAST_SUN + MIN)).toBe(NEXT_SUN);
    expect(advanceClosesAt(LAST_SUN, LAST_SUN)).toBe(NEXT_SUN);
  });

  it("skips whole weeks after an outage until it's in the future", () => {
    expect(advanceClosesAt(LAST_SUN, NEXT_SUN)).toBe(NEXT_SUN + CLOSE_WEEK_MS);
    expect(advanceClosesAt(LAST_SUN, NEXT_SUN + 1)).toBe(NEXT_SUN + CLOSE_WEEK_MS);
    expect(advanceClosesAt(LAST_SUN, NEXT_SUN + 3 * CLOSE_WEEK_MS + H)).toBe(NEXT_SUN + 4 * CLOSE_WEEK_MS);
    // Always the same weekday and time of day.
    const later = advanceClosesAt(LAST_SUN, LAST_SUN + 50 * CLOSE_WEEK_MS + 5 * H);
    expect((later - LAST_SUN) % CLOSE_WEEK_MS).toBe(0);
    expect(later).toBeGreaterThan(LAST_SUN + 50 * CLOSE_WEEK_MS + 5 * H);
  });
});

describe("legacy close time (state from before closesAt)", () => {
  it("finds the Sunday 20:00 UTC slot at or before a time", () => {
    expect(closeSlotAtOrBefore(WED)).toBe(LAST_SUN);
    expect(closeSlotAtOrBefore(NEXT_SUN)).toBe(NEXT_SUN);
    expect(closeSlotAtOrBefore(NEXT_SUN - 1)).toBe(LAST_SUN);
    expect(closeSlotAtOrBefore(Date.UTC(2026, 10, 1, 9))).toBe(LAST_SUN);
  });

  it("derives the next Sunday 20:00 UTC", () => {
    expect(legacyClosesAt(WED, LAST_SUN + MIN)).toBe(NEXT_SUN);
    expect(legacyClosesAt(WED, null)).toBe(NEXT_SUN);
  });

  it("keeps a just-missed slot owed when the old cron was running late", () => {
    // Sunday 21:00, last close was the week before: this Sunday's close is owed now.
    expect(legacyClosesAt(NEXT_SUN + H, LAST_SUN + MIN)).toBe(NEXT_SUN);
    // Already closed this Sunday: next week.
    expect(legacyClosesAt(NEXT_SUN + H, NEXT_SUN + 10 * MIN)).toBe(NEXT_SUN + CLOSE_WEEK_MS);
    // Long past the slot: assume it isn't owed.
    expect(legacyClosesAt(NEXT_SUN + 8 * H, LAST_SUN)).toBe(NEXT_SUN + CLOSE_WEEK_MS);
  });

  it("prefers the stored close time", () => {
    expect(effectiveClosesAt({ closesAt: 123, lastCloseAt: null }, WED)).toBe(123);
    expect(effectiveClosesAt({ lastCloseAt: null }, WED)).toBe(NEXT_SUN);
  });
});

describe("countdown", () => {
  it("counts down to closesAt and is due once it passes", () => {
    expect(nextScheduledClose(WED, { closesAt: NEXT_SUN, lastCloseAt: LAST_SUN })).toEqual({ at: NEXT_SUN, due: false });
    expect(nextScheduledClose(NEXT_SUN, { closesAt: NEXT_SUN, lastCloseAt: LAST_SUN })).toEqual({ at: NEXT_SUN, due: true });
    expect(nextScheduledClose(NEXT_SUN + 40_000, { closesAt: NEXT_SUN, lastCloseAt: LAST_SUN }).due).toBe(true);
  });

  it("formats the two most significant units", () => {
    expect(formatCountdown(2 * 24 * H + 4 * H + 59_000)).toBe("2d 4h");
    expect(formatCountdown(3 * H + 12 * MIN)).toBe("3h 12m");
    expect(formatCountdown(4 * MIN + 9_000)).toBe("4m 09s");
    expect(formatCountdown(-5)).toBe("0m 00s");
  });

  it("formats a close time in UK time (GMT and BST)", () => {
    expect(formatCloseTime(Date.UTC(2026, 10, 8, 20))).toBe("Sun 8 Nov, 20:00");
    // 19:00 UTC in July is 20:00 BST.
    expect(formatCloseTime(Date.UTC(2026, 6, 12, 19))).toBe("Sun 12 Jul, 20:00");
  });
});

describe("validating an admin-set close time", () => {
  it("needs a number at least five minutes ahead and within a year", () => {
    expect(closeTimeError(WED + 10 * MIN, WED)).toBeNull();
    expect(closeTimeError(WED + 5 * MIN, WED)).toBeNull();
    expect(closeTimeError(WED + 4 * MIN, WED)).toMatch(/5 minutes/);
    expect(closeTimeError(WED - H, WED)).toMatch(/5 minutes/);
    expect(closeTimeError(WED + 400 * 24 * H, WED)).toMatch(/year/);
    expect(closeTimeError("tomorrow", WED)).toMatch(/date and time/);
    expect(closeTimeError(Number.NaN, WED)).toMatch(/date and time/);
  });
});
