"use client";

import { useEffect, useState } from "react";

/** The current time, re-rendering every `ms`. Null until mounted, so the static prerender never bakes in a time. */
export function useNow(ms = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
