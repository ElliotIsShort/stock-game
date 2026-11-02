import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { bankruptcyMessage, settleDebt, type Creditor, type Holding, type Player } from "@fsm/shared";
import { auditEntry, auditRef, refs } from "./common";
import { enqueueDiscord } from "./discord";
import type { PoolLedger } from "./margin";

/**
 * Settle a player's debt, liquidating ALL their holdings and paying creditors
 * proportionally. If they can't cover it, they're marked bankrupt: deactivated
 * but their stock stays listed so holders can sell. Reactivated at the next
 * weekly close.
 *
 * Only reached from a forced liquidation (margin.ts) when selling every
 * holding still can't cover the player's shorts. Must run inside a transaction
 * that has already read the debtor, their holdings and the stocks. Pool
 * changes go through `ledger` (the caller flushes it once per stock);
 * `debtorExtra` is merged into the debtor's single player-doc write.
 *
 * The pure maths lives in @fsm/shared `settleDebt` (unit-tested).
 */
export function applyBankruptcySettlement(
  tx: Transaction,
  debtor: Player,
  debtorHoldings: Holding[],
  ledger: PoolLedger,
  debt: number,
  creditors: Creditor[],
  feePct: number,
  now: number,
  week: number,
  debtorExtra: Record<string, unknown> = {},
): ReturnType<typeof settleDebt> {
  const holdings = debtorHoldings
    .filter((h) => h.shares > 0 && ledger.pool(h.stockId))
    .map((h) => ({ stockId: h.stockId, shares: h.shares, pool: ledger.pool(h.stockId)! }));

  const result = settleDebt(debtor.cash, holdings, debt, creditors, feePct);

  // Apply each liquidation sale to its pool and remove the holding.
  for (const sale of result.sales) {
    const s = ledger.pool(sale.stockId)!;
    const newShares = s.poolShares + sale.shares;
    const newCash = (s.poolCash * s.poolShares) / newShares;
    ledger.apply(sale.stockId, newCash, newShares, newCash / newShares);
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
    ...debtorExtra,
  });

  if (result.bankrupt) enqueueDiscord(tx, "high", "bankruptcy", bankruptcyMessage(debtor.uid, debtor.displayName, debt, result.shortfall), now);
  tx.set(
    auditRef(),
    auditEntry("system", result.bankrupt ? "bankruptcy" : "debtSettled", debtor.uid, {
      debt,
      raised: result.raised,
      shortfall: result.shortfall,
      payouts: result.payouts,
      week,
    }, now),
  );
  return result;
}
