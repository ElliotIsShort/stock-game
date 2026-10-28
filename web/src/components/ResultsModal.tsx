"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { doc } from "firebase/firestore";
import { reportWinners, type WeeklyReport } from "@fsm/shared";
import { fb } from "@/lib/firebase";
import { useDoc } from "@/lib/hooks";
import { fireConfetti } from "@/lib/confetti";
import { changeClass, gbp, pct, profileHref } from "@/lib/format";
import { playSound } from "@/lib/sound";
import { Avatar } from "./Avatar";
import { useGame } from "./GameProvider";

export function reportId(week: number): string {
  return `week-${String(week).padStart(4, "0")}`;
}

/**
 * The results screen after a weekly close: your place, the winners, the
 * awards. Shown once automatically (see Moments) and from any report page.
 * A native <dialog>, so focus is trapped and Esc closes it.
 */
export function ResultsModal({ week, onClose }: { week: number; onClose: () => void }) {
  const { me } = useGame();
  const report = useDoc<WeeklyReport>(doc(fb().db, "weeklyReports", reportId(week)), [week]);
  const ref = useRef<HTMLDialogElement>(null);
  const celebrated = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const r = report.data;
  const winners = r ? reportWinners(r) : [];
  const place = r && me ? r.highlights.growth.findIndex((g) => g.uid === me.uid) : -1;
  const mine = place >= 0 && r ? r.highlights.growth[place] : null;
  const myPrize = me ? winners.find((w) => w.playerId === me.uid) : undefined;
  const wonWeek = Boolean(me && winners[0]?.playerId === me.uid);

  useEffect(() => {
    if (!r || celebrated.current) return;
    celebrated.current = true;
    if (wonWeek) {
      fireConfetti();
      playSound("success");
    }
  }, [r, wonWeek]);

  const awards = r?.highlights.awards ?? [];
  const indexChange = r?.changes?.index ?? null;

  return (
    <dialog ref={ref} className="modal results" aria-labelledby="results-title" onClose={onClose} onCancel={onClose}>
      <div className="modal-body stack">
        <div className="row between">
          <h2 id="results-title">Week {week} results</h2>
          <button type="button" className="link" onClick={() => ref.current?.close()} aria-label="Close results">✕</button>
        </div>
        {!r ? (
          <p className="muted" aria-live="polite">{report.loading ? "Loading…" : "Report not found."}</p>
        ) : (
          <>
            {mine && (
              <div className={`results-you${wonWeek ? " won" : ""}`}>
                <div className="results-place" aria-hidden="true">{wonWeek ? "🏆" : `#${place + 1}`}</div>
                <div>
                  <strong>{wonWeek ? "You won the week!" : `You finished #${place + 1} of ${r.highlights.growth.length}`}</strong>
                  <div className="small">
                    <span className={changeClass(mine.weeklyGrowth)}>{pct(mine.weeklyGrowth, 2)}</span> weekly growth
                    {myPrize && <> · won <strong>{gbp(myPrize.prizeAmount)}</strong></>}
                  </div>
                </div>
              </div>
            )}

            <section aria-label="Winners">
              {winners.length === 0 ? (
                <p className="muted">Nobody qualified; the prize pool rolled over.</p>
              ) : (
                <ol className="podium">
                  {winners.map((w, i) => (
                    <li key={w.playerId} className={`podium-${i + 1}`}>
                      <span className="podium-medal" aria-hidden="true">{["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}</span>
                      <Avatar uid={w.playerId} name={w.name} size={32} />
                      <Link href={profileHref(w.playerId)} onClick={() => ref.current?.close()}>{w.name}</Link>
                      <span className={`small ${changeClass(w.growth)}`}>{pct(w.growth, 2)}</span>
                      <span className="small muted">{gbp(w.prizeAmount)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {awards.length > 0 && (
              <section aria-labelledby="results-awards">
                <h3 id="results-awards" className="small muted">Awards</h3>
                <ul className="awards">
                  {awards.map((a) => (
                    <li key={a.key} className={a.playerId === me?.uid ? "mine" : undefined}>
                      <span className="award-emoji" aria-hidden="true">{a.emoji}</span>
                      <span>
                        <strong>{a.title}</strong>: {a.name}
                        <span className="muted small"> · {a.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <p className="small muted">
              Market index {r.prices.index.toFixed(1)}
              {indexChange !== null && <span className={changeClass(indexChange)}> ({indexChange >= 0 ? "+" : ""}{indexChange.toFixed(1)})</span>}
              {" "}· {r.activity.tradeCount} trades · {gbp(r.money.prizePaid)} prize pool
            </p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <Link href={`/report/?id=${reportId(week)}`} className="button-link" onClick={() => ref.current?.close()}>Full report</Link>
              <button type="button" className="primary" onClick={() => ref.current?.close()}>Nice</button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
