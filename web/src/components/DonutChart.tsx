"use client";

import { useEffect, useState } from "react";
import { gbp } from "@/lib/format";
import { useTweened } from "@/lib/hooks";

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  /** Optional fixed colour (e.g. muted for cash); otherwise taken from the palette. */
  color?: string;
}

/** Distinct on the dark theme; cycles if there are more slices than colours. */
export const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf", "#ff9e64", "#7ee787", "#e3b341", "#a5d6ff"];

/** Keep the ring readable: past `max` slices, the smallest are merged into "Others". */
function groupSlices(slices: DonutSlice[], max: number): DonutSlice[] {
  const positive = slices.filter((s) => s.value > 0);
  if (positive.length <= max) return positive;
  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const keep = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((a, s) => a + s.value, 0);
  return [...keep, { id: "__others", label: "Others", value: rest, color: "#8b949e" }];
}

/**
 * Donut chart with animated arcs, a centre readout and a legend (after
 * easyui's donut-chart). Hover or focus a slice/legend row to read it in the
 * centre; tap a legend row to pin it (useful on touch). The legend is the
 * accessible version of the data.
 */
export function DonutChart({
  slices,
  label,
  centreLabel = "Total",
  format = gbp,
  size = 168,
  maxSlices = 8,
}: {
  slices: DonutSlice[];
  label: string;
  centreLabel?: string;
  format?: (n: number) => string;
  size?: number;
  maxSlices?: number;
}) {
  const shown = groupSlices(slices, maxSlices).map((s, i) => ({ ...s, color: s.color ?? PALETTE[i % PALETTE.length] }));
  const total = shown.reduce((a, s) => a + s.value, 0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const activeId = hovered ?? pinned;
  const active = shown.find((s) => s.id === activeId) ?? null;

  // Draw in from zero on mount, then tween between data updates.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const fracs = useTweened(
    shown.map((s) => (drawn && total > 0 ? s.value / total : 0)),
    700,
  );

  const stroke = Math.round(size * 0.13);
  const r = size / 2 - stroke / 2 - 4;
  const C = 2 * Math.PI * r;
  const gap = shown.length > 1 ? 2 : 0;
  let offset = 0;

  if (total <= 0) return <p className="muted small">Nothing to show yet.</p>;

  return (
    <div className="donut">
      <div className="donut-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${shown.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(0)}%`).join(", ")}`}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={stroke} />
            {shown.map((s, i) => {
              const len = Math.max(0, (fracs[i] ?? 0) * C - gap);
              const start = offset;
              offset += (fracs[i] ?? 0) * C;
              const dim = activeId !== null && activeId !== s.id;
              return (
                <circle
                  key={s.id}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={activeId === s.id ? stroke + 4 : stroke}
                  strokeDasharray={`${len} ${C}`}
                  strokeDashoffset={-start}
                  className={`donut-slice${dim ? " dim" : ""}`}
                  pointerEvents="stroke"
                  onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(s.id)}
                  onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(null)}
                  onClick={() => setPinned((p) => (p === s.id ? null : s.id))}
                />
              );
            })}
          </g>
        </svg>
        <div className="donut-centre" aria-hidden="true">
          <span className="muted small donut-centre-label">{active ? active.label : centreLabel}</span>
          <strong>{format(active ? active.value : total)}</strong>
          {active && <span className="muted small">{((active.value / total) * 100).toFixed(1)}%</span>}
        </div>
      </div>
      <ul className="donut-legend">
        {shown.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-pressed={pinned === s.id}
              className={activeId !== null && activeId !== s.id ? "dim" : undefined}
              onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(s.id)}
              onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(null)}
              onFocus={() => setHovered(s.id)}
              onBlur={() => setHovered(null)}
              onClick={() => setPinned((p) => (p === s.id ? null : s.id))}
            >
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              <span className="donut-legend-name">{s.label}</span>
              <span className="donut-legend-value">{format(s.value)}</span>
              <span className="muted donut-legend-pct">{((s.value / total) * 100).toFixed(0)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Half-ring gauge (easyui donut-chart's gauge mode). `preview` shows where a
 * pending action would take the value, as a lighter segment beyond `value`.
 */
export function Gauge({
  value,
  max,
  preview,
  label,
  format = gbp,
}: {
  value: number;
  max: number;
  preview?: number;
  label: string;
  format?: (n: number) => string;
}) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const frac = max > 0 ? value / max : value > 0 ? 1 : 0;
  const previewFrac = preview !== undefined && max > 0 ? preview / max : frac;
  const [f, pf] = useTweened([drawn ? Math.min(frac, 1) : 0, drawn ? Math.min(previewFrac, 1) : 0], 500);
  const over = previewFrac > 1 + 1e-9;
  const tone = over || frac >= 1 ? "var(--down)" : Math.max(frac, previewFrac) >= 0.75 ? "var(--warn)" : "var(--accent)";

  const W = 180;
  const stroke = 14;
  const r = W / 2 - stroke / 2 - 2;
  const cy = W / 2;
  const arc = `M ${W / 2 - r} ${cy} A ${r} ${r} 0 0 1 ${W / 2 + r} ${cy}`;
  const pctText = `${Math.round(Math.max(frac, previewFrac) * 100)}%`;

  return (
    <figure className="gauge">
      <svg width={W} height={W / 2 + stroke / 2 + 2} viewBox={`0 0 ${W} ${W / 2 + stroke / 2 + 2}`} role="img"
        aria-label={`${label}: ${format(value)} of ${format(max)}${preview !== undefined && preview !== value ? `, ${format(preview)} after this trade` : ""}`}>
        <path d={arc} fill="none" stroke="var(--panel-2)" strokeWidth={stroke} strokeLinecap="round" />
        {pf > f && <path d={arc} pathLength={100} fill="none" stroke={tone} strokeOpacity={0.35} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${pf * 100} 100`} />}
        {f > 0 && <path d={arc} pathLength={100} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${f * 100} 100`} />}
        <text x={W / 2} y={cy - 8} textAnchor="middle" className="gauge-pct" fill={over ? "var(--down)" : "var(--text)"}>{pctText}</text>
      </svg>
      <figcaption className="small muted">
        {label}: {format(preview ?? value)} of {format(max)}
        {over && <span className="down"> · over your limit</span>}
      </figcaption>
    </figure>
  );
}
