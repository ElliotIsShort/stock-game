"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { niceScale } from "@/lib/chart";
import { gbp } from "@/lib/format";
import { useTweened } from "@/lib/hooks";

export interface BarSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

const PAD = { t: 12, r: 8, b: 24, l: 48 };
const TIP_W = 168;
const compact = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", notation: "compact", maximumFractionDigits: 1 });

/**
 * Grouped SVG bar chart (after easyui's bar-chart): legend buttons toggle
 * series and the bars morph to the new layout; hover, tap or arrow-key through
 * categories for a tooltip.
 */
export function BarChart({
  categories,
  series,
  label,
  height = 220,
  format = gbp,
}: {
  categories: string[];
  series: BarSeries[];
  label: string;
  height?: number;
  format?: (n: number) => string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = series.filter((s) => !hidden.has(s.key));
  const max = Math.max(0, ...visible.flatMap((s) => s.values));
  const { hi, ticks } = niceScale(0, max || 1);
  const n = categories.length;
  const innerW = Math.max(1, width - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const groupW = innerW / Math.max(1, n);
  const barArea = groupW * 0.72;
  const barW = visible.length ? barArea / visible.length : 0;

  // Target geometry for every (series, category); hidden series collapse to the group centre.
  const target: number[] = [];
  series.forEach((s) => {
    const vi = visible.indexOf(s);
    categories.forEach((_, c) => {
      const gx = PAD.l + c * groupW + (groupW - barArea) / 2;
      const x = vi >= 0 ? gx + vi * barW : PAD.l + c * groupW + groupW / 2;
      const w = vi >= 0 ? Math.max(1, barW - 2) : 0;
      const h = vi >= 0 ? ((s.values[c] ?? 0) / hi) * innerH : 0;
      target.push(x, w, h);
    });
  });
  // Bars rise from zero on first draw.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (width > 0 && !drawn) {
      const id = requestAnimationFrame(() => setDrawn(true));
      return () => cancelAnimationFrame(id);
    }
  }, [width, drawn]);
  // Empty until measured so the first real layout snaps into place (a length change never tweens).
  const geo = useTweened(width === 0 ? [] : drawn ? target : target.map((v, i) => (i % 3 === 2 ? 0 : v)), 450);

  function toggle(key: string) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else if (series.length - next.size > 1) next.add(key); // keep at least one series
      return next;
    });
  }

  function onPointer(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const c = Math.floor((e.clientX - box.left - PAD.l) / groupW);
    setHover(c >= 0 && c < n ? c : null);
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const cur = hover ?? (e.key === "ArrowLeft" ? n : -1);
      setHover(Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape") setHover(null);
  }

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 44))));
  const tipX = hover === null ? 0 : Math.min(Math.max(0, PAD.l + hover * groupW + groupW / 2 - TIP_W / 2), Math.max(0, width - TIP_W));

  return (
    <figure className="bchart">
      <div className="bchart-legend" role="group" aria-label="Series">
        {series.map((s) => (
          <button key={s.key} type="button" aria-pressed={!hidden.has(s.key)} onClick={() => toggle(s.key)}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </button>
        ))}
      </div>
      <div ref={wrapRef} className="ichart-plot" style={{ height }}>
        {width > 0 && (
          <>
            <svg
              width={width}
              height={height}
              role="img"
              tabIndex={0}
              aria-label={`${label}. Use the left and right arrow keys to read each column.`}
              onKeyDown={onKeyDown}
              onBlur={() => setHover(null)}
            >
              <g className="ichart-axes">
                {ticks.map((v) => {
                  const y = PAD.t + innerH - (v / hi) * innerH;
                  return (
                    <g key={v}>
                      <line x1={PAD.l} x2={width - PAD.r} y1={y} y2={y} className="ichart-grid" />
                      <text x={PAD.l - 8} y={y} textAnchor="end" dominantBaseline="middle">{compact.format(v)}</text>
                    </g>
                  );
                })}
                {categories.map((c, i) =>
                  i % labelEvery === 0 ? (
                    <text key={c} x={PAD.l + i * groupW + groupW / 2} y={height - 6} textAnchor="middle">{c}</text>
                  ) : null,
                )}
              </g>
              {hover !== null && (
                <rect x={PAD.l + hover * groupW} y={PAD.t} width={groupW} height={innerH} className="bchart-hover" />
              )}
              {series.map((s, si) =>
                categories.map((c, ci) => {
                  const i = (si * n + ci) * 3;
                  const h = Math.max(0, geo[i + 2] ?? 0);
                  const w = geo[i + 1] ?? 0;
                  if (w <= 0.1) return null;
                  return <rect key={`${s.key}-${c}`} x={geo[i]} y={PAD.t + innerH - h} width={w} height={h} rx={Math.min(3, w / 2)} fill={s.color} />;
                }),
              )}
              <rect
                x={0}
                y={0}
                width={width}
                height={height}
                fill="transparent"
                style={{ touchAction: "pan-y" }}
                onPointerDown={onPointer}
                onPointerMove={onPointer}
                onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
              />
            </svg>
            {hover !== null && (
              <div className="ichart-tip on bchart-tip" style={{ width: TIP_W, transform: `translateX(${tipX}px)` }} aria-hidden="true">
                <span className="muted">{categories[hover]}</span>
                {visible.map((s) => (
                  <span key={s.key} className="bchart-tip-row">
                    <span><span className="swatch" style={{ background: s.color }} /> {s.label}</span>
                    <strong>{format(s.values[hover] ?? 0)}</strong>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {hover !== null ? `${categories[hover]}: ${visible.map((s) => `${s.label} ${format(s.values[hover] ?? 0)}`).join(", ")}` : ""}
      </span>
    </figure>
  );
}
