import type { AlertDirection, PriceAlert } from "./types";

export type AlertCheck = { ok: true } | { ok: false; error: string };

/** A new alert must point away from the current price, or it would fire straight away. */
export function validateAlert(direction: unknown, price: unknown, currentPrice: number): AlertCheck {
  if (direction !== "above" && direction !== "below") return { ok: false, error: "Direction must be above or below." };
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1e9) return { ok: false, error: "Enter a price above £0." };
  if (direction === "above" && !(price > currentPrice)) return { ok: false, error: "That's not above the current price." };
  if (direction === "below" && !(price < currentPrice)) return { ok: false, error: "That's not below the current price." };
  return { ok: true };
}

export function alertFires(alert: Pick<PriceAlert, "direction" | "price" | "status">, price: number): boolean {
  if (alert.status !== "active") return false;
  return alert.direction === "above" ? price >= alert.price : price <= alert.price;
}

export function alertSummary(stockName: string, direction: AlertDirection, price: number): string {
  return `${stockName} ${direction === "above" ? "rises above" : "drops below"} £${price.toFixed(2)}`;
}
