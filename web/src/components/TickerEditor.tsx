"use client";

import { useState, type FormEvent } from "react";
import { TICKER_MAX_LENGTH, TICKER_MIN_LENGTH, normaliseTicker, validateTicker, type Stock } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { useGame } from "./GameProvider";

/** Pick your stock's ticker (e.g. Joe Bloggs → JOE or BLG). Uniqueness and the cooldown are enforced server-side. */
export function TickerEditor({ stock }: { stock: Stock }) {
  const { tickerOf, stocks, config } = useGame();
  const current = tickerOf(stock.id);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const next = normaliseTicker(value);
  const check = validateTicker(value);
  const taken = check.ok && next !== current && stocks.some((s) => s.id !== stock.id && tickerOf(s.id) === next);
  const cooldownMs = config.tickerChangeCooldownHours * 3_600_000;
  const waitMs = stock.tickerChangedAt ? stock.tickerChangedAt + cooldownMs - Date.now() : 0;
  const waiting = waitMs > 0;
  const invalid = value.length > 0 && !check.ok;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!check.ok || taken || next === current) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.setTicker(next);
      setDone(`You now trade as $${res.ticker}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack ticker-editor" onSubmit={submit}>
      <label>
        Ticker
        <div className="row">
          <span className="ticker-prefix" aria-hidden="true">$</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.toUpperCase())}
            minLength={TICKER_MIN_LENGTH}
            maxLength={TICKER_MAX_LENGTH + 1}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid || taken}
            aria-describedby="ticker-help"
          />
          <button type="submit" className="primary" disabled={busy || !check.ok || taken || next === current || waiting}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <span id="ticker-help" className="muted small">
          {TICKER_MIN_LENGTH}–{TICKER_MAX_LENGTH} letters. Everyone sees it on the market and the ticker tape.
          {waiting && ` You can change it again in ${Math.ceil(waitMs / 3_600_000)}h.`}
        </span>
      </label>
      {invalid && !check.ok && <p className="error small" role="alert">{check.error}</p>}
      {taken && <p className="error small" role="alert">${next} is taken.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      {done && <p className="success small" role="status">{done}</p>}
    </form>
  );
}
