"use client";

import Link from "next/link";
import { useMemo } from "react";
import { collection, orderBy, query } from "firebase/firestore";
import type { WeeklyReport } from "@fsm/shared";
import { BarChart } from "@/components/BarChart";
import { useGame } from "@/components/GameProvider";
import { LineChart } from "@/components/LineChart";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { gbp } from "@/lib/format";

/** Weeks shown in the money-flow chart; older weeks are still in the list below. */
const CHART_WEEKS = 12;

export default function ReportsPage() {
  const { stocks } = useGame();
  const reports = useQuery<WeeklyReport>(query(collection(fb().db, "weeklyReports"), orderBy("week", "desc")), []);

  const recent = useMemo(() => [...reports.data].slice(0, CHART_WEEKS).reverse(), [reports.data]);

  // Market index = average of price ÷ listing price × 100, one point per close plus the live value now.
  const indexPoints = useMemo(() => {
    const pts = [...reports.data].reverse().map((r) => ({ t: r.periodEnd, v: r.prices.index }));
    const listed = stocks.filter((s) => s.listed && s.listPrice > 0);
    if (listed.length > 0) pts.push({ t: Date.now(), v: (listed.reduce((a, s) => a + s.price / s.listPrice, 0) / listed.length) * 100 });
    return pts;
  }, [reports.data, stocks]);

  return (
    <div className="stack">
      <h1>Weekly reports</h1>
      {reports.error && <p className="error" role="alert">{reports.error.message}</p>}
      {!reports.loading && reports.data.length === 0 && <p className="muted">No weeks have closed yet.</p>}

      {reports.data.length > 0 && (
        <div className="grid-2 even">
          <section className="card">
            <h2>Market index</h2>
            <p className="small muted">Average stock price relative to its listing price. 100 = where everyone started.</p>
            <LineChart points={indexPoints} label="Market index" format={(n) => n.toFixed(1)} ranges={["1M", "3M", "1Y"]} height={200} />
          </section>
          <section className="card">
            <h2>Money flow</h2>
            <p className="small muted">New money paid out each week vs. trading fees collected{reports.data.length > CHART_WEEKS ? ` (last ${CHART_WEEKS} weeks)` : ""}.</p>
            <BarChart
              label="Allowances, CEO bonuses and fees by week"
              categories={recent.map((r) => `W${r.week}`)}
              height={200}
              series={[
                { key: "allowances", label: "Allowances", color: "#58a6ff", values: recent.map((r) => r.money.allowancesPaid) },
                { key: "bonuses", label: "CEO bonuses", color: "#3fb950", values: recent.map((r) => r.money.bonusesPaid) },
                { key: "fees", label: "Fees", color: "#d29922", values: recent.map((r) => r.money.feesCollected) },
              ]}
            />
          </section>
        </div>
      )}

      <ul className="plain">
        {reports.data.map((r) => (
          <li key={r.id} className="card row between wrap">
            <Link href={`/report/?id=${encodeURIComponent(r.id)}`}>Week {r.week}</Link>
            <span className="muted small">
              {new Date(r.generatedAt).toLocaleDateString("en-GB")} ·{" "}
              {r.highlights.winner ? `${r.highlights.winner.name} won ${gbp(r.highlights.winner.prize)}` : "no winner"} ·{" "}
              {r.activity.tradeCount} trades · {r.flags.length} flag(s)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
