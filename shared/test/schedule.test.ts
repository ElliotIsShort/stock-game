import { describe, expect, it } from "vitest";
import { closeSlotAtOrBefore, formatCountdown, nextScheduledClose } from "../src/schedule";

const H = 3_600_000;
// Wednesday 28 Oct 2026, 12:00 UTC. The surrounding Sunday 20:00 UTC slots:
const WED = Date.UTC(2026, 9, 28, 12);
const LAST_SUN = Date.UTC(2026, 9, 25, 20);
const NEXT_SUN = Date.UTC(2026, 10, 1, 20);

describe("weekly close schedule", () => {
  it("finds the Sunday 20:00 UTC slot at or before a time", () => {
    expect(closeSlotAtOrBefore(WED)).toBe(LAST_SUN);
    expect(closeSlotAtOrBefore(NEXT_SUN)).toBe(NEXT_SUN);
    expect(closeSlotAtOrBefore(NEXT_SUN - 1)).toBe(LAST_SUN);
    // Sunday morning is before that day's slot.
    expect(closeSlotAtOrBefore(Date.UTC(2026, 10, 1, 9))).toBe(LAST_SUN);
  });

  it("counts down to the next Sunday after a normal close", () => {
    expect(nextScheduledClose(WED, LAST_SUN + 60_000, 144)).toEqual({ at: NEXT_SUN, due: false });
    expect(nextScheduledClose(WED, null, 144)).toEqual({ at: NEXT_SUN, due: false });
  });

  it("skips a slot the cron would skip after a recent manual close", () => {
    // Manual close on Friday: Sunday is only ~2 days later, inside the 144h window.
    const friday = Date.UTC(2026, 9, 30, 18);
    expect(nextScheduledClose(friday + H, friday, 144)).toEqual({ at: NEXT_SUN + 7 * 24 * H, due: false });
    // With the window disabled, Sunday still runs.
    expect(nextScheduledClose(friday + H, friday, 0)).toEqual({ at: NEXT_SUN, due: false });
  });

  it("reports a just-passed slot as due until the close lands", () => {
    expect(nextScheduledClose(NEXT_SUN + 20 * 60_000, LAST_SUN, 144)).toEqual({ at: NEXT_SUN, due: true });
    // Once it has closed, move on to the following week.
    expect(nextScheduledClose(NEXT_SUN + 20 * 60_000, NEXT_SUN + 5 * 60_000, 144)).toEqual({ at: NEXT_SUN + 7 * 24 * H, due: false });
    // Well past the grace period without a close: assume it was missed.
    expect(nextScheduledClose(NEXT_SUN + 5 * H, LAST_SUN, 144)).toEqual({ at: NEXT_SUN + 7 * 24 * H, due: false });
  });

  it("formats the two most significant units", () => {
    expect(formatCountdown(2 * 24 * H + 4 * H + 59_000)).toBe("2d 4h");
    expect(formatCountdown(3 * H + 12 * 60_000)).toBe("3h 12m");
    expect(formatCountdown(4 * 60_000 + 9_000)).toBe("4m 09s");
    expect(formatCountdown(-5)).toBe("0m 00s");
  });
});
