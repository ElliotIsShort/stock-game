"use client";

import { useState, type FormEvent } from "react";
import { DISCORD_ID_RE } from "@fsm/shared";
import { api, errorMessage } from "@/lib/api";
import { useGame } from "./GameProvider";

/** Paste your Discord user ID so the market's Discord posts can @mention you. */
export function DiscordLink() {
  const { me } = useGame();
  const [value, setValue] = useState(me?.discordId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!me) return null;

  const trimmed = value.trim();
  const valid = DISCORD_ID_RE.test(trimmed);

  async function save(id: string | null) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.setDiscordId(id);
      setDone(id ? "Linked. You'll be @mentioned when something happens to your stock." : "Unlinked.");
      if (!id) setValue("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid && trimmed !== me?.discordId) void save(trimmed);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        Discord user ID
        <div className="row">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 123456789012345678"
            aria-invalid={trimmed !== "" && !valid}
            aria-describedby="discord-help"
          />
          <button type="submit" className="primary" disabled={busy || !valid || trimmed === me.discordId}>Save</button>
          {me.discordId && <button type="button" className="link danger small" disabled={busy} onClick={() => save(null)}>Unlink</button>}
        </div>
      </label>
      <details id="discord-help" className="small muted">
        <summary>How do I find it?</summary>
        <ol>
          <li>In Discord, open <strong>User Settings → Advanced</strong> and turn on <strong>Developer Mode</strong>.</li>
          <li>Click your own name or avatar (on a phone: tap your profile), then <strong>Copy User ID</strong>.</li>
          <li>Paste it here. It&apos;s a long number, not your username.</li>
        </ol>
      </details>
      {trimmed !== "" && !valid && <p className="error small" role="alert">That should be a 17–20 digit number.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      {done && <p className="success small" role="status">{done}</p>}
    </form>
  );
}
