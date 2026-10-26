"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { availableRanges, easeInOut, nearestIndex, niceScale, resample, windowPoints, type ChartPoint } from "@/lib/chart";
import { changeClass, gbp, pct } from "@/lib/format";
import { prefersReducedMotion, useSlideIndicator } from "@/lib/hooks";

export type { ChartPoint };

/**
 * Interactive, dependency-free SVG area chart (after easyui's
 * interactive-area-chart). Used for price history, net-worth history and
 * per-holding value.
 *
 * - Range buttons (1D/1W/…/All), only offered when the data is longer than the window.
 * - Every range is resampled to the same number of points so switching ranges,
 *   or a live trade arriving, morphs the line rather than jumping. Interruptible.
 * - Scrub with mouse, touch (drag horizontally; vertical drags still scroll) or
 *   the arrow keys. Snaps to real data points.
 * - `step` draws a step line (price holds until the next trade).
 */
export function LineChart(props: {
  points: ChartPoint[];
  label: string;
  step?: boolean;
  /** Optional horizontal reference line (e.g. cost basis), drawn dashed. */
  baseline?: number;
  baselineLabel?: string;
  height?: number;
  /** Range keys to offer, from RANGE_OPTIONS. "All" is always added. */
  ranges?: string[];
}) {
  if (props.points.length < 2) return <p className="muted small">Not enough data to chart yet.</p>;
  return <InteractiveChart {...props} />;
}

const N = 160;
const PAD = { t: 36, r: 10, b: 24, l: 48 };
const TIP_W = 136;
const MORPH_MS = 550;
const REVEAL_MS = 900;

const RANGE_TEXT: Record<string, string> = {
  "1D": "past day",
  "1W": "past week",
  "1M": "past month",
  "3M": "past 3 months",
  "1Y": "past year",
  All: "all time",
};

const compact = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", notation: "compact", maximumFractionDigits: 1 });

function axisFormat(spanMs: number): Intl.DateTimeFormat {
  if (spanMs <= 2 * 86_400_000) return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 120 * 86_400_000) return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" });
}

function tipFormat(withTime: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(
    "en-GB",
    withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" },
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const r2 = (n: number) => Math.round(n * 100) / 100;

function InteractiveChart({
  points,
  label,
  step = false,
  baseline,
  baselineLabel,
  height = 220,
  ranges = ["1W", "1M", "3M"],
}: {
  points: ChartPoint[];
  label: string;
  step?: boolean;
  baseline?: number;
  baselineLabel?: string;
  height?: number;
  ranges?: string[];
}) {
  const uid = useId().replace(/:/g, "");
  const sorted = useMemo(() => [...points].sort((a, b) => a.t - b.t), [points]);
  const rangeKeys = ranges.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const options = useMemo(() => availableRanges(sorted, ranges), [sorted, rangeKeys]);
  const [rangeKey, setRangeKey] = useState("All");
  const active = options.find((o) => o.key === rangeKey) ?? options[options.length - 1];

  // Model for the active range: real points (for hover) + normalised samples (for drawing).
  const model = useMemo(() => {
    const pts = windowPoints(sorted, active.ms, step);
    const samples = resample(pts, N, step);
    let min = Math.min(...samples, ...pts.map((p) => p.v));
    let max = Math.max(...samples, ...pts.map((p) => p.v));
    if (baseline !== undefined) {
      min = Math.min(min, baseline);
      max = Math.max(max, baseline);
    }
    const { lo, hi, ticks } = niceScale(min, max);
    const norm = (v: number) => (v - lo) / (hi - lo);
    return {
      pts,
      ny: samples.map(norm),
      base: baseline === undefined ? null : norm(baseline),
      lo,
      hi,
      ticks,
      t0: pts[0].t,
      t1: pts[pts.length - 1].t,
    };
  }, [sorted, active.ms, step, baseline]);

  // ---- Width tracking ----
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

  // ---- Intro reveal (left → right) ----
  const [reveal, setReveal] = useState(0);
  const measured = width > 0;
  useEffect(() => {
    if (!measured) return;
    if (prefersReducedMotion()) {
      setReveal(1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / REVEAL_MS);
      setReveal(easeInOut(x));
      if (x < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setReveal(1);
    };
  }, [measured]);

  // ---- Morph between datasets (range change or live update). Interruptible. ----
  const fromRef = useRef<{ ny: number[]; base: number | null } | null>(null);
  const toRef = useRef<{ ny: number[]; base: number | null }>({ ny: model.ny, base: model.base });
  const progRef = useRef(1);
  const [, setFrame] = useState(0);
  const mounted = useRef(false);

  const current = (): { ny: number[]; base: number | null } => {
    const from = fromRef.current;
    const to = toRef.current;
    const p = progRef.current;
    if (!from || p >= 1) return to;
    const lerp = (a: number, b: number) => a + (b - a) * p;
    return {
      ny: to.ny.map((v, k) => lerp(from.ny[k] ?? v, v)),
      base: to.base === null ? null : from.base === null ? to.base : lerp(from.base, to.base),
    };
  };

  useEffect(() => {
    const target = { ny: model.ny, base: model.base };
    if (!mounted.current) {
      mounted.current = true;
      toRef.current = target;
      return;
    }
    fromRef.current = current();
    toRef.current = target;
    if (prefersReducedMotion()) {
      progRef.current = 1;
      setFrame((f) => f + 1);
      return;
    }
    progRef.current = 0;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / MORPH_MS);
      progRef.current = easeInOut(x);
      setFrame((f) => f + 1);
      if (x < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // ---- Hover / scrub ----
  const [hover, setHover] = useState<number | null>(null);
  const [glide, setGlide] = useState(false);
  const [fromKeyboard, setFromKeyboard] = useState(false);

  const innerW = Math.max(1, width - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const bottom = PAD.t + innerH;
  const xAtSample = (k: number) => PAD.l + (k / (N - 1)) * innerW;
  const xAtTime = (t: number) => PAD.l + ((t - model.t0) / (model.t1 - model.t0 || 1)) * innerW;
  const yAtNorm = (n: number) => PAD.t + (1 - n) * innerH;
  const yAtValue = (v: number) => yAtNorm((v - model.lo) / (model.hi - model.lo));

  const hoverAt = (idx: number | null, keyboard = false) => {
    if (idx !== null && hover === null) {
      // Don't sweep in from the previous spot on first contact.
      setGlide(false);
      requestAnimationFrame(() => setGlide(true));
    }
    setFromKeyboard(keyboard);
    setHover(idx);
  };

  function selectRange(key: string) {
    if (key === active.key) return;
    hoverAt(null);
    setRangeKey(key);
  }

  function onScrub(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const frac = clamp((e.clientX - box.left - PAD.l) / innerW, 0, 1);
    hoverAt(nearestIndex(model.pts, model.t0 + frac * (model.t1 - model.t0)));
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const last = model.pts.length - 1;
    const cur = hover ?? last;
    let next: number | null = cur;
    if (e.key === "ArrowLeft") next = clamp(cur - 1, 0, last);
    else if (e.key === "ArrowRight") next = clamp(cur + 1, 0, last);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    hoverAt(next, true);
  }

  // ---- Derived display ----
  const pts = model.pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const shown = hover !== null ? pts[Math.min(hover, pts.length - 1)] : last;
  const delta = first.v !== 0 ? shown.v / first.v - 1 : 0;
  const trendUp = last.v >= first.v;
  const span = model.t1 - model.t0;
  const tip = tipFormat(step || span <= 2 * 86_400_000);
  const axis = axisFormat(span);
  const rangeText = RANGE_TEXT[active.key] ?? active.key;

  const { ny, base } = current();
  let line = "";
  if (width > 0) {
    line = `M${r2(xAtSample(0))} ${r2(yAtNorm(ny[0]))}`;
    for (let k = 1; k < N; k++) {
      line += step ? `H${r2(xAtSample(k))}V${r2(yAtNorm(ny[k]))}` : `L${r2(xAtSample(k))} ${r2(yAtNorm(ny[k]))}`;
    }
  }
  const area = width > 0 ? `${line}L${r2(xAtSample(N - 1))} ${bottom}L${r2(xAtSample(0))} ${bottom}Z` : "";

  const labelCount = width < 380 ? 3 : width < 560 ? 4 : 5;
  const xLabels = Array.from({ length: labelCount }, (_, j) => model.t0 + (j / (labelCount - 1)) * span);

  const hx = hover !== null ? xAtTime(shown.t) : 0;
  const hy = hover !== null ? yAtValue(shown.v) : 0;
  const tipX = clamp(hx - TIP_W / 2, 0, Math.max(0, width - TIP_W));

  const { ref: rangeRef, box: pill } = useSlideIndicator<HTMLDivElement>('[aria-pressed="true"]', [active.key, options.length]);

  return (
    <figure className="ichart">
      <div className="ichart-head">
        <div>
          <p className="ichart-value">{gbp(shown.v)}</p>
          <p className="small">
            <span className={changeClass(delta)}>{pct(delta)}</span>{" "}
            <span className="muted">{hover !== null ? tip.format(shown.t) : rangeText}</span>
          </p>
        </div>
        {options.length > 1 && (
          <div className="range-pills" role="group" aria-label="Time range" ref={rangeRef}>
            {pill && (
              <span
                className={`slide-indicator${pill.animate ? " animate" : ""}`}
                aria-hidden="true"
                style={{ transform: `translate(${pill.x}px, ${pill.y}px)`, width: pill.w, height: pill.h }}
              />
            )}
            {options.map((o) => (
              <button key={o.key} type="button" aria-pressed={o.key === active.key} onClick={() => selectRange(o.key)}>
                {o.key}
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={wrapRef} className="ichart-plot" style={{ height }}>
        {width > 0 && (
          <>
            <svg
              width={width}
              height={height}
              role="img"
              tabIndex={0}
              aria-label={`${label}, ${rangeText}: from ${gbp(first.v)} to ${gbp(last.v)}. Use the left and right arrow keys to inspect values.`}
              style={{ color: trendUp ? "var(--up)" : "var(--down)" }}
              onKeyDown={onKeyDown}
              onBlur={() => hoverAt(null)}
            >
              <defs>
                <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                </linearGradient>
                <clipPath id={`${uid}-clip`}>
                  <rect x={0} y={0} height={height} width={reveal >= 1 ? width : PAD.l + innerW * reveal} />
                </clipPath>
              </defs>

              {/* Grid + axes; keyed by range so they fade in on change. */}
              <g key={active.key} className="ichart-axes">
                {model.ticks.map((v) => {
                  const y = yAtValue(v);
                  return (
                    <g key={v}>
                      <line x1={PAD.l} x2={width - PAD.r} y1={y} y2={y} className="ichart-grid" />
                      <text x={PAD.l - 8} y={y} textAnchor="end" dominantBaseline="middle">
                        {compact.format(v)}
                      </text>
                    </g>
                  );
                })}
                {xLabels.map((t, j) => (
                  <text
                    key={j}
                    x={xAtTime(t)}
                    y={height - 6}
                    textAnchor={j === 0 ? "start" : j === xLabels.length - 1 ? "end" : "middle"}
                  >
                    {axis.format(t)}
                  </text>
                ))}
              </g>

              <g clipPath={`url(#${uid}-clip)`}>
                <path d={area} fill={`url(#${uid}-fill)`} />
                <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {base !== null && (
                  <g className="ichart-baseline">
                    <line x1={PAD.l} x2={width - PAD.r} y1={yAtNorm(base)} y2={yAtNorm(base)} />
                    {baselineLabel && (
                      <text x={width - PAD.r} y={yAtNorm(base) - 4} textAnchor="end">
                        {baselineLabel}
                      </text>
                    )}
                  </g>
                )}
              </g>

              {/* Crosshair + dot */}
              <g className={`ichart-cursor${hover !== null ? " on" : ""}${glide ? " glide" : ""}`} pointerEvents="none">
                <g style={{ transform: `translateX(${hx}px)` }}>
                  <line x1={0} x2={0} y1={PAD.t - 4} y2={bottom} />
                </g>
                <g style={{ transform: `translate(${hx}px, ${hy}px)` }}>
                  <circle r={4.5} />
                </g>
              </g>

              {/* Pointer surface: horizontal drags scrub, vertical drags still scroll the page. */}
              <rect
                x={0}
                y={0}
                width={width}
                height={height}
                fill="transparent"
                style={{ touchAction: "pan-y", cursor: "crosshair" }}
                onPointerDown={onScrub}
                onPointerMove={onScrub}
                onPointerLeave={() => hoverAt(null)}
                onPointerCancel={() => hoverAt(null)}
              />
            </svg>

            <div
              className={`ichart-tip${hover !== null ? " on" : ""}${glide ? " glide" : ""}`}
              style={{ width: TIP_W, transform: `translateX(${tipX}px)` }}
              aria-hidden="true"
            >
              <span className="muted">{tip.format(shown.t)}</span>
              <strong>{gbp(shown.v)}</strong>
            </div>
          </>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {fromKeyboard && hover !== null ? `${tip.format(shown.t)}: ${gbp(shown.v)}` : ""}
      </span>
    </figure>
  );
}
