import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { bankruptcyMessage, priceTick, settleDebt, type Creditor, type Holding, type Player, type Stock } from "@fsm/shared";
import { auditEntry, auditRef, refs } from "./common";
import { enqueueDiscord } from "./discord";

/**
 * Settle a player's debt, liquidating their holdings and paying creditors
 * proportionally. If they can't cover it, they're marked bankrupt: deactivated
 * but their stock stays listed so holders can sell. Reactivated at the next
 * weekly close.
 *
 * Internal mechanism only — nothing calls it yet. It's here so the future
 * short-selling / lending features can trigger a settlement. Must run inside a
 * transaction that has already read the debtor, their holdings and the stocks.
 *
 * The pure maths lives in @fsm/shared `settleDebt` (unit-tested); this applies
 * the pool, wallet and flag changes.
 */
export function applyBankruptcySettlement(
  tx: Transaction,
  debtor: Player,
  debtorHoldings: Holding[],
  stockOf: Map<string, Stock>,
  debt: number,
  creditors: Creditor[],
  feePct: number,
  now: number,
  week: number,
): ReturnType<typeof settleDebt> {
  const holdings = debtorHoldings
    .filter((h) => h.shares > 0 && stockOf.has(h.stockId))
    .map((h) => {
      const s = stockOf.get(h.stockId)!;
      return { stockId: h.stockId, shares: h.shares, pool: { poolCash: s.poolCash, poolShares: s.poolShares } };
    });

  const result = settleDebt(debtor.cash, holdings, debt, creditors, feePct);

  // Apply each liquidation sale to its pool and remove the holding.
  for (const sale of result.sales) {
    const s = stockOf.get(sale.stockId)!;
    const newShares = s.poolShares + sale.shares;
    const newCash = (s.poolCash * s.poolShares) / newShares;
    const price = newCash / newShares;
    // Keep sparklines and records honest; fire sales don't get their own Discord post.
    const { recentPrices, allTimeHigh, allTimeLow } = priceTick(s, price, week).patch;
    tx.update(refs.stock(s.id), { poolShares: newShares, poolCash: newCash, k: newShares * newCash, price, recentPrices, allTimeHigh, allTimeLow });
    tx.delete(refs.holding(debtor.uid, sale.stockId));
  }

  // Pay creditors.
  for (const p of result.payouts) {
    if (p.paid > 0) tx.update(refs.player(p.uid), { cash: FieldValue.increment(p.paid) });
  }

  // Debtor ends with their remaining cash; bankrupt players are deactivated.
  tx.update(refs.player(debtor.uid), {
    cash: result.remainingCash,
    ...(result.bankrupt ? { isActive: false, bankruptAt: now } : {}),
  });

  if (result.bankrupt) enqueueDiscord(tx, "high", "bankruptcy", bankruptcyMessage(debtor.uid, debtor.displayName, debt, result.shortfall), now);
  tx.set(
    auditRef(),
    auditEntry("system", result.bankrupt ? "bankruptcy" : "debtSettled", debtor.uid, {
      debt,
      raised: result.raised,
      shortfall: result.shortfall,
      payouts: result.payouts,
    }, now),
  );
  return result;
}
