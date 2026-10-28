/**
 * Stock tickers ("JOE", "BLG"): 2–5 letters A–Z, unique across all stocks.
 * Players pick their own; everyone gets a default from their name at listing.
 * Stocks listed before tickers existed get the same default, assigned in
 * listing order, so every client and the server agree on them.
 */

export const TICKER_MIN_LENGTH = 2;
export const TICKER_MAX_LENGTH = 5;
const TICKER_RE = /^[A-Z]{2,5}$/;
const FALLBACK_BASE = "STK";

/** Trim, drop a leading "$" and upper-case. Doesn't validate. */
export function normaliseTicker(raw: string): string {
  return raw.trim().replace(/^\$/, "").toUpperCase();
}

export type TickerResult = { ok: true; ticker: string } | { ok: false; error: string };

export function validateTicker(raw: unknown): TickerResult {
  if (typeof raw !== "string") return { ok: false, error: "Ticker must be text." };
  const ticker = normaliseTicker(raw);
  if (!TICKER_RE.test(ticker)) {
    return { ok: false, error: `Ticker must be ${TICKER_MIN_LENGTH}–${TICKER_MAX_LENGTH} letters (A–Z).` };
  }
  return { ok: true, ticker };
}

/** Upper-case A–Z words from a name, with accents stripped ("Zoë O'Neil" → ["ZOE", "ONEIL"]). */
function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z]/g, ""))
    .filter(Boolean);
}

/** Default tickers to try for a name, best first. All are valid tickers. */
export function tickerCandidates(name: string): string[] {
  const words = nameWords(name);
  const joined = words.join("");
  const first = words[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1] : "";
  const raw = [
    first.slice(0, 3),
    last.slice(0, 3),
    first.slice(0, 1) + last.slice(0, 2),
    words.length > 1 ? words.map((w) => w[0]).join("").slice(0, TICKER_MAX_LENGTH) : "",
    joined.slice(0, 4),
    joined.slice(0, 5),
  ];
  const out: string[] = [];
  for (const c of raw) if (TICKER_RE.test(c) && !out.includes(c)) out.push(c);
  return out;
}

/** The best unused default for `name`. Always returns a valid ticker not in `taken`. */
export function defaultTicker(name: string, taken: ReadonlySet<string>): string {
  const candidates = tickerCandidates(name);
  for (const c of candidates) if (!taken.has(c)) return c;
  const base = (candidates[0] ?? FALLBACK_BASE).slice(0, 3);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) if (!taken.has(base + a)) return base + a;
  for (const a of letters) for (const b of letters) if (!taken.has(base + a + b)) return base + a + b;
  // 700+ collisions on one base: not reachable at friend-group scale.
  throw new Error(`No free ticker for ${name}`);
}

export interface TickerSource {
  id: string;
  displayName: string;
  listedAt: number;
  ticker?: string;
}

/**
 * Every stock's effective ticker: its stored one, or (for stocks listed before
 * tickers existed) a default assigned in listing order that avoids every
 * stored ticker. Deterministic, so client and server always agree.
 */
export function assignTickers(stocks: readonly TickerSource[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of stocks) {
    if (s.ticker) {
      out.set(s.id, s.ticker);
      taken.add(s.ticker);
    }
  }
  const legacy = stocks.filter((s) => !s.ticker).sort((a, b) => a.listedAt - b.listedAt || a.id.localeCompare(b.id));
  for (const s of legacy) {
    const t = defaultTicker(s.displayName, taken);
    out.set(s.id, t);
    taken.add(t);
  }
  return out;
}
