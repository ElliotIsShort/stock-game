export function gbp(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "+£2.10" / "−£0.45" / "£0.00", for price and value deltas. */
export function signedGbp(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = gbp(Math.abs(n));
  if (Math.abs(n) < 0.005) return abs;
  return `${n > 0 ? "+" : "−"}${abs}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

export function shares(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
}

export function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function changeClass(n: number): string {
  return n > 0.00005 ? "up" : n < -0.00005 ? "down" : "flat";
}

/** Links are relative to basePath automatically via next/link; this helps for query strings. */
export function stockHref(id: string): string {
  return `/stock/?id=${encodeURIComponent(id)}`;
}

/** A player's profile: the Player tab of their stock page. */
export function profileHref(id: string): string {
  return `/stock/?id=${encodeURIComponent(id)}&tab=player`;
}

/** "3 days", "5 hours", "20 minutes". */
export function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
