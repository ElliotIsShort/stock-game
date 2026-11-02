/**
 * When the week closes. The exact instant lives in game state
 * (`meta/state.closesAt`, epoch ms): an admin sets it, and every scheduled
 * close moves it on by whole weeks so the weekday and time of day stay put.
 * The per-minute `closeScheduler` function closes the week once it's due.
 */
import type { GameState } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const CLOSE_WEEK_MS = 7 * DAY_MS;

/** An admin-set close time must be at least this far in the future. */
export const MIN_CLOSE_LEAD_MS = 5 * 60_000;
/** ...and no more than this far (a typo guard; a year is plenty). */
export const MAX_CLOSE_LEAD_MS = 366 * DAY_MS;

/**
 * The schedule the old GitHub Actions cron used (Sundays 20:00 UTC). Only used
 * to derive `closesAt` once for game state from before it existed.
 */
export const LEGACY_CLOSE_SCHEDULE = { dayOfWeekUtc: 0, hourUtc: 20 } as const;
/** The old cron often ran hours late; a legacy slot this recent that hasn't closed yet is still owed. */
const LEGACY_CATCH_UP_MS = 6 * HOUR_MS;

/** The most recent legacy slot at or before `t`. */
export function closeSlotAtOrBefore(t: number, schedule = LEGACY_CLOSE_SCHEDULE): number {
  const d = new Date(t);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), schedule.hourUtc);
  const slot = today - ((d.getUTCDay() - schedule.dayOfWeekUtc + 7) % 7) * DAY_MS;
  return slot <= t ? slot : slot - CLOSE_WEEK_MS;
}

/**
 * `closesAt` for state written before it existed: the next Sunday 20:00 UTC.
 * If the old cron's slot passed within the last few hours and the week hasn't
 * closed since (it was running late), that slot is still owed, so it's
 * returned and the scheduler closes straight away.
 */
export function legacyClosesAt(now: number, lastCloseAt: number | null): number {
  const prev = closeSlotAtOrBefore(now);
  const owed = lastCloseAt !== null && lastCloseAt < prev && now - prev < LEGACY_CATCH_UP_MS;
  return owed ? prev : prev + CLOSE_WEEK_MS;
}

/**
 * The next close after a scheduled one: +7 days from the previous close time
 * (not from now, so the weekday and time are kept). If that's still not in
 * the future (e.g. after an outage), whole weeks are added until it is.
 */
export function advanceClosesAt(previous: number, now: number): number {
  const next = previous + CLOSE_WEEK_MS;
  if (next > now) return next;
  return next + Math.ceil((now - next + 1) / CLOSE_WEEK_MS) * CLOSE_WEEK_MS;
}

/** The close time stored in state, or the legacy-derived one for state from before it was stored. */
export function effectiveClosesAt(state: Pick<GameState, "closesAt" | "lastCloseAt">, now: number): number {
  return typeof state.closesAt === "number" && Number.isFinite(state.closesAt) ? state.closesAt : legacyClosesAt(now, state.lastCloseAt);
}

/** Why an admin-entered close time is unacceptable, or null when it's fine. */
export function closeTimeError(closesAt: unknown, now: number): string | null {
  if (typeof closesAt !== "number" || !Number.isFinite(closesAt)) return "Pick a date and time.";
  if (closesAt < now + MIN_CLOSE_LEAD_MS) return "The close must be at least 5 minutes in the future.";
  if (closesAt > now + MAX_CLOSE_LEAD_MS) return "The close must be within a year.";
  return null;
}

export interface CloseEstimate {
  /** Epoch ms the week closes. */
  at: number;
  /** The close time has passed but the scheduler hasn't closed the week yet (up to about a minute). */
  due: boolean;
}

/** The current week's close, for the countdown. */
export function nextScheduledClose(now: number, state: Pick<GameState, "closesAt" | "lastCloseAt">): CloseEstimate {
  const at = effectiveClosesAt(state, now);
  return { at, due: now >= at };
}

/** "Sun 8 Nov, 20:00" in UK time, for posts and the admin echo. */
export function formatCloseTime(at: number): string {
  return new Date(at).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
