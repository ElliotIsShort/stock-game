"use client";

import { useEffect, useRef, useState } from "react";
import { gbp } from "@/lib/format";
import { useTweened } from "@/lib/hooks";

/**
 * A number that counts smoothly to its new value and briefly tints green/red
 * when it changes (after easyui's animated-number). Tabular figures so the
 * width doesn't jitter while counting.
 */
export function AnimatedNumber({ value, format = gbp, className = "" }: { value: number; format?: (n: number) => string; className?: string }) {
  const [shown] = useTweened([value], 600);
  const prev = useRef(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    // Ignore float dust so re-pricing by fractions of a penny doesn't flash.
    if (Math.abs(value - before) < 0.005) return;
    setFlash(value > before ? "up" : "down");
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
  }, [value]);

  return <span className={`anum${flash ? ` flash-${flash}` : ""}${className ? ` ${className}` : ""}`}>{format(shown)}</span>;
}
