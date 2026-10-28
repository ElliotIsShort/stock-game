/**
 * When the automatic weekly close runs. Must match the cron in
 * .github/workflows/weekly-close.yml ("0 20 * * 0" = Sundays 20:00 UTC).
 */
export const WEEKLY_CLOSE_SCHEDULE = { dayOfWeekUtc: 0, hourUtc: 20 } as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** GitHub's scheduled workflows often start late; treat a just-passed slot as "closing now" for this long. */
export const CLOSE_GRACE_MS = 3 * HOUR_MS;

/** The most recent scheduled slot at or before `t`. */
export function closeSlotAtOrBefore(t: number, schedule = WEEKLY_CLOSE_SCHEDULE): number {
  const d = new Date(t);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), schedule.hourUtc);
  const slot = today - ((d.getUTCDay() - schedule.dayOfWeekUtc + 7) % 7) * DAY_MS;
  return slot <= t ? slot : slot - WEEK_MS;
}

export interface CloseEstimate {
  /** Epoch ms of the slot. */
  at: number;
  /** The slot has passed but the close hasn't happened yet (the cron is running or late). */
  due: boolean;
}

/**
 * The next automatic close. The cron skips itself within
 * `minHoursBetweenAutoCloses` of the last close (e.g. after an admin closed
 * manually), so those slots are skipped here too.
 */
export function nextScheduledClose(
  now: number,
  lastCloseAt: number | null,
  minHoursBetweenAutoCloses: number,
  schedule = WEEKLY_CLOSE_SCHEDULE,
): CloseEstimate {
  const wouldRun = (slot: number) => lastCloseAt === null || slot - lastCloseAt >= minHoursBetweenAutoCloses * HOUR_MS;
  const prev = closeSlotAtOrBefore(now, schedule);
  const closedSincePrev = lastCloseAt !== null && lastCloseAt >= prev;
  if (now - prev < CLOSE_GRACE_MS && !closedSincePrev && wouldRun(prev)) return { at: prev, due: true };
  let slot = prev + WEEK_MS;
  // Bounded: minHoursBetweenAutoCloses is capped at 1000h (< 6 weeks).
  for (let i = 0; i < 52 && !wouldRun(slot); i++) slot += WEEK_MS;
  return { at: slot, due: false };
}

/** "2d 4h", "3h 12m", "4m 09s" — the two most significant units. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}
