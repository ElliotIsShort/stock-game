"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { useGame } from "./GameProvider";

/**
 * Write a post: standalone, tagged to a person (yourself included), or linked
 * to one of your trades. Posts never move prices — players decide what to do.
 */
export function PostComposer({
  defaultTag,
  linkedTradeId,
  onDone,
  compact,
}: {
  defaultTag?: string;
  linkedTradeId?: string;
  onDone?: () => void;
  compact?: boolean;
}) {
  const { stocks, config, me } = useGame();
  const [text, setText] = useState("");
  const [tag, setTag] = useState(defaultTag ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seconds left on the post cooldown after a successful post.
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  if (!me?.isActive) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createPost({ text: text.trim(), taggedStockId: linkedTradeId ? null : tag || null, linkedTradeId: linkedTradeId ?? null });
      setText("");
      // Trade-linked posts aren't rate-limited server-side, so only count down standalone posts.
      if (!linkedTradeId) setCooldown(config.postCooldownSeconds);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const listed = stocks.filter((s) => s.listed).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <form onSubmit={submit} className={`composer${compact ? " compact" : ""}`}>
      <label className="sr-only" htmlFor={`post-${linkedTradeId ?? defaultTag ?? "main"}`}>Post</label>
      <textarea
        id={`post-${linkedTradeId ?? defaultTag ?? "main"}`}
        placeholder={linkedTradeId ? "Why did you make this trade?" : "Post your thoughts"}
        maxLength={config.maxPostLength}
        rows={compact ? 2 : 3}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        {!linkedTradeId && !defaultTag && (
          <label className="inline">
            About{" "}
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">No one in particular</option>
              {listed.map((s) => (
                <option key={s.id} value={s.id}>{s.id === me.uid ? `${s.displayName} (me)` : s.displayName}</option>
              ))}
            </select>
          </label>
        )}
        <span className="muted small">{text.length}/{config.maxPostLength}</span>
        <button type="submit" className="primary" disabled={busy || !text.trim() || cooldown > 0}>
          {cooldown > 0 ? `Wait ${cooldown}s` : "Post"}
        </button>
        {onDone && <button type="button" onClick={onDone}>Cancel</button>}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </form>
  );
}
