"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onSnapshot, type DocumentReference, type Query } from "firebase/firestore";

export interface Live<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

/** Live-subscribe to a single document. Pass null to skip. */
export function useDoc<T>(ref: DocumentReference | null, deps: unknown[]): Live<T | null> {
  const [state, setState] = useState<Live<T | null>>({ data: null, loading: Boolean(ref), error: null });
  useEffect(() => {
    if (!ref) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      ref,
      (snap) => setState({ data: snap.exists() ? (snap.data() as T) : null, loading: false, error: null }),
      (error) => setState({ data: null, loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Track a CSS media query. False during the static prerender and first client render. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Read at the moment an animation starts, so it's never stale. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Smoothly animate between successive values of `target` (e.g. bar heights,
 * a balance). The first render shows the target as-is; later changes tween
 * from whatever is on screen, so rapid updates never jump. A change of length
 * snaps instead of tweening.
 */
export function useTweened(target: number[], ms = 450): number[] {
  const fromRef = useRef(target);
  const toRef = useRef(target);
  const progRef = useRef(1);
  const [, setFrame] = useState(0);
  const mounted = useRef(false);
  const key = target.join(",");

  const current = () => {
    const from = fromRef.current;
    const to = toRef.current;
    const p = progRef.current;
    if (p >= 1 || from.length !== to.length) return to;
    return to.map((v, i) => from[i] + (v - from[i]) * p);
  };

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const shown = current();
    toRef.current = target;
    if (shown.length !== target.length || prefersReducedMotion()) {
      fromRef.current = target;
      progRef.current = 1;
      setFrame((f) => f + 1);
      return;
    }
    fromRef.current = shown;
    progRef.current = 0;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / ms);
      progRef.current = 1 - (1 - x) ** 3;
      setFrame((f) => f + 1);
      if (x < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);

  return current();
}

/**
 * Position a sliding "active" indicator under whichever child matches
 * `activeSelector` inside the returned ref's element (which must be
 * position: relative). `animate` is false for the first placement so the
 * indicator doesn't sweep in from the corner on load.
 */
export function useSlideIndicator<T extends HTMLElement>(activeSelector: string, deps: unknown[]) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; animate: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>(activeSelector);
      if (!active) {
        setBox(null);
        return;
      }
      const next = { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
      setBox((prev) =>
        prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : { ...next, animate: prev !== null },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, box };
}

/** Live-subscribe to a query. Pass null to skip. */
export function useQuery<T>(q: Query | null, deps: unknown[]): Live<T[]> {
  const [state, setState] = useState<Live<T[]>>({ data: [], loading: Boolean(q), error: null });
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as T), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
