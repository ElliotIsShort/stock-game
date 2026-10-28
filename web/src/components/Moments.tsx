"use client";

import { useEffect, useRef, useState } from "react";
import { fireConfetti } from "@/lib/confetti";
import { playSound } from "@/lib/sound";
import { useGame } from "./GameProvider";
import { ResultsModal } from "./ResultsModal";

/** Wait this long after the market loads before treating rank changes as real (avoids load-order flicker). */
const SETTLE_MS = 2000;
const BANNER_MS = 8000;

/**
 * Celebrations: the weekly results screen (once per close, per player), and
 * a confetti banner when you take #1 on the leaderboard, live or since your
 * last visit.
 */
export function Moments() {
  const { me, state, playerById, marketReady, previousSession, sessionKnown } = useGame();
  const [resultsWeek, setResultsWeek] = useState<number | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const uid = me?.uid ?? null;

  // Results: the latest close, if it happened since your last session and you haven't seen it on this device.
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || !me || !state || !sessionKnown) return;
    decided.current = true;
    const week = state.currentWeek - 1;
    if (week < 1 || me.joinWeek > week) return;
    if (previousSession && previousSession.week > week) return;
    const key = `fsm:resultsSeen:${me.uid}`;
    if (Number(localStorage.getItem(key) ?? 0) >= week) return;
    localStorage.setItem(key, String(week));
    setResultsWeek(week);
  }, [me, state, sessionKnown, previousSession]);

  // Taking #1.
  const rank = uid ? (playerById.get(uid)?.rank ?? null) : null;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!marketReady) return;
    const id = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [marketReady]);
  const lastRank = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!settled || !sessionKnown) return;
    // First check compares with your last visit; after that, with the last live rank.
    const first = lastRank.current === undefined;
    const prev = first ? (previousSession?.rank ?? null) : (lastRank.current ?? null);
    lastRank.current = rank;
    if (rank === 1 && prev !== null && prev > 1) {
      setBanner(first ? "You've climbed to #1 since your last visit." : "You just took #1 on the leaderboard.");
      fireConfetti();
      playSound("success");
    }
  }, [settled, sessionKnown, rank, previousSession]);

  useEffect(() => {
    if (!banner) return;
    const id = window.setTimeout(() => setBanner(null), BANNER_MS);
    return () => window.clearTimeout(id);
  }, [banner]);

  return (
    <>
      {banner && (
        <div className="moment-banner" role="status">
          <span aria-hidden="true">🏆</span> <strong>{banner}</strong>
          <button type="button" className="link" onClick={() => setBanner(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {resultsWeek !== null && <ResultsModal week={resultsWeek} onClose={() => setResultsWeek(null)} />}
    </>
  );
}
