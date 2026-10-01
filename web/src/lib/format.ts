export function gbp(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
