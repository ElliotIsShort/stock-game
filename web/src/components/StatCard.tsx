"use client";

import type { ReactNode } from "react";
import { gbp } from "@/lib/format";
import { AnimatedNumber } from "./AnimatedNumber";

/**
 * KPI tile: label, a counting headline number, an optional sub-line and an
 * optional sparkline (after easyui's stat-card). The sparkline is decorative;
 * the full, accessible chart lives elsewhere on the page.
 */
export function StatCard({
  label,
  value,
  format = gbp,
  sub,
  spark,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  sub?: ReactNode;
  spark?: number[];
}) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="big"><AnimatedNumber value={value} format={format} /></div>
      {sub && <div className="small muted">{sub}</div>}
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const W = 100;
  const H = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join("");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style={{ color: up ? "var(--up)" : "var(--down)" }}>
      <path d={`${line}L${W} ${H}L0 ${H}Z`} fill="currentColor" opacity={0.15} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
