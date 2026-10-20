"use client";

import { LineChart } from "./LineChart";

/** Price history as a step line (price holds until the next trade). */
export function PriceChart({ points, label }: { points: { t: number; p: number }[]; label: string }) {
  return <LineChart points={points.map((d) => ({ t: d.t, v: d.p }))} label={label} step />;
}
