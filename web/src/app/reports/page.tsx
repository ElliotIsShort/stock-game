"use client";

import Link from "next/link";
import { collection, orderBy, query } from "firebase/firestore";
import type { WeeklyReport } from "@fsm/shared";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { gbp } from "@/lib/format";

export default function ReportsPage() {
  const reports = useQuery<WeeklyReport>(query(collection(fb().db, "weeklyReports"), orderBy("week", "desc")), []);
  return (
    <div className="stack">
      <h1>Weekly reports</h1>
      {reports.error && <p className="error" role="alert">{reports.error.message}</p>}
      {!reports.loading && reports.data.length === 0 && <p className="muted">No weeks have closed yet.</p>}
      <ul className="plain">
        {reports.data.map((r) => (
          <li key={r.id} className="card row between">
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
