"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { doc } from "firebase/firestore";
import type { WeeklyReport } from "@fsm/shared";
import { fb } from "@/lib/firebase";
import { useDoc } from "@/lib/hooks";
import { changeClass, gbp, pct } from "@/lib/format";

export default function ReportPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <ReportView />
    </Suspense>
  );
}

function ReportView() {
  const id = useSearchParams().get("id") ?? "";
  const report = useDoc<WeeklyReport>(id ? doc(fb().db, "weeklyReports", id) : null, [id]);
  const [copied, setCopied] = useState<string | null>(null);

  if (report.loading) return <p className="muted">Loading…</p>;
  const r = report.data;
  if (!r) return <p className="muted">Report not found.</p>;

  async function copy(kind: "markdown" | "json") {
    if (!r) return;
    const text = kind === "markdown" ? r.markdown : JSON.stringify(r, null, 2);
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  }

  const c = r.changes;
  const delta = (key: string, fmt: (n: number) => string) =>
    c[key] === null || c[key] === undefined ? null : (
      <span className={`small ${changeClass(c[key]!)}`}> ({c[key]! >= 0 ? "+" : "−"}{fmt(Math.abs(c[key]!))})</span>
    );

  return (
    <div className="stack">
      <div className="row between wrap">
        <h1>Week {r.week} report</h1>
        <div className="row">
          <button type="button" onClick={() => copy("markdown")}>{copied === "markdown" ? "Copied" : "Copy for AI (Markdown)"}</button>
          <button type="button" onClick={() => copy("json")}>{copied === "json" ? "Copied" : "Copy JSON"}</button>
        </div>
      </div>
      <p className="muted small">
        {new Date(r.periodStart).toLocaleString("en-GB")} → {new Date(r.periodEnd).toLocaleString("en-GB")} · triggered by {r.trigger}
      </p>

      <section className="card">
        <h2>Highlights</h2>
        <p>
          {r.highlights.winner
            ? <>🏆 <strong>{r.highlights.winner.name}</strong> won {gbp(r.highlights.winner.prize)} with {pct(r.highlights.winner.weeklyGrowth, 2)} weekly growth.</>
            : "No eligible winner this week; the prize pool rolled over."}
        </p>
        {r.flags.length > 0 && (
          <ul>
            {r.flags.map((f, i) => <li key={i} className="flag">⚠️ {f.message}</li>)}
          </ul>
        )}
      </section>

      <div className="stats">
        <div className="stat"><div className="muted small">Total net worth</div><div className="big">{gbp(r.money.totalNetWorth)}</div>{delta("totalNetWorth", gbp)}</div>
        <div className="stat"><div className="muted small">Median price</div><div className="big">{gbp(r.prices.medianPrice)}</div>{delta("medianPrice", gbp)}</div>
        <div className="stat"><div className="muted small">Index</div><div className="big">{r.prices.index.toFixed(1)}</div>{delta("index", (n) => n.toFixed(1))}</div>
        <div className="stat"><div className="muted small">Trades</div><div className="big">{r.activity.tradeCount}</div>{delta("tradeCount", String)}</div>
        <div className="stat"><div className="muted small">Avg move / trade</div><div className="big">{pct(r.health.avgMovePerTrade, 2)}</div></div>
        <div className="stat"><div className="muted small">Fees → prize</div><div className="big">{gbp(r.money.feesCollected)}</div>{delta("feesCollected", gbp)}</div>
      </div>

      <section className="card">
        <h2>Prices</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Stock</th>
                <th scope="col" className="num">Open</th>
                <th scope="col" className="num">Close</th>
                <th scope="col" className="num">High</th>
                <th scope="col" className="num">Low</th>
                <th scope="col" className="num">Change</th>
                <th scope="col" className="num">Trades</th>
              </tr>
            </thead>
            <tbody>
              {r.prices.stocks.map((s) => (
                <tr key={s.stockId}>
                  <th scope="row">{s.name}</th>
                  <td className="num">{gbp(s.open)}</td>
                  <td className="num">{gbp(s.close)}</td>
                  <td className="num">{gbp(s.high)}</td>
                  <td className="num">{gbp(s.low)}</td>
                  <td className={`num ${changeClass(s.pctChange)}`}>{pct(s.pctChange)}</td>
                  <td className="num">{s.tradeCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Full report</h2>
        <pre className="report-md">{r.markdown}</pre>
      </section>
    </div>
  );
}
