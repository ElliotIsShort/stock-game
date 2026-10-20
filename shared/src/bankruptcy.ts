import { quoteSell, type Pool } from "./amm";
import { roundMoney } from "./economy";

/**
 * Bankruptcy settlement (future-facing: debts only exist once shorting/loans
 * are added). A debtor owes `debt`. We first liquidate all their holdings back
 * to the pools at the current price, add that to their cash, then pay creditors.
 *
 * If cash + liquidation covers the debt, it's paid in full and they keep the
 * change — not bankrupt. Otherwise everything they have is split among the
 * creditors proportionally to what each is owed, the shortfall is the
 * creditors' loss (a risky loan/short is their own risk), and the debtor is
 * marked bankrupt: account deactivated, but their stock stays listed so holders
 * can still sell.
 */

export interface DebtorHolding {
  stockId: string;
  shares: number;
  /** The pool of that stock, so we can price the liquidation. */
  pool: Pool;
}

export interface Creditor {
  uid: string;
  /** Amount this creditor is owed. */
  owed: number;
}

export interface LiquidationSale {
  stockId: string;
  shares: number;
  /** Net cash raised after the trading fee. */
  cash: number;
}

export interface CreditorPayout {
  uid: string;
  owed: number;
  paid: number;
}

export interface SettlementResult {
  bankrupt: boolean;
  /** Cash available after liquidation (starting cash + sale proceeds). */
  raised: number;
  /** Total the debtor owed. */
  debt: number;
  /** Holdings sold to raise cash. */
  sales: LiquidationSale[];
  /** What each creditor actually received. */
  payouts: CreditorPayout[];
  /** Debtor's cash left after settling (0 when bankrupt, change when solvent). */
  remainingCash: number;
  /** Debt that couldn't be covered (0 when solvent); the creditors' loss. */
  shortfall: number;
}

/**
 * Compute a settlement. Pure: the caller applies the resulting pool changes,
 * wallet changes and bankruptcy flag inside a transaction. `feePct` is the
 * trading fee applied to each liquidation sale (same as a normal sell).
 */
export function settleDebt(
  cash: number,
  holdings: DebtorHolding[],
  debt: number,
  creditors: Creditor[],
  feePct: number,
): SettlementResult {
  const sales: LiquidationSale[] = [];
  let raised = cash;
  for (const h of holdings) {
    if (!(h.shares > 0) || !(h.pool.poolCash > 0) || !(h.pool.poolShares > 0)) continue;
    const q = quoteSell(h.pool, h.shares, feePct);
    raised += q.netCash;
    sales.push({ stockId: h.stockId, shares: h.shares, cash: q.netCash });
  }
  raised = roundMoney(raised);
  const totalOwed = creditors.reduce((a, c) => a + c.owed, 0);
  const solvent = raised >= debt;

  if (solvent) {
    // Pay everyone in full; debtor keeps the change.
    const payouts = creditors.map((c) => ({ uid: c.uid, owed: c.owed, paid: roundMoney(c.owed) }));
    return { bankrupt: false, raised, debt, sales, payouts, remainingCash: roundMoney(raised - debt), shortfall: 0 };
  }

  // Insolvent: split everything raised, proportional to what each is owed.
  let distributed = 0;
  const payouts: CreditorPayout[] = creditors.map((c) => {
    const share = totalOwed > 0 ? (c.owed / totalOwed) * raised : 0;
    const paid = roundMoney(share);
    distributed += paid;
    return { uid: c.uid, owed: c.owed, paid };
  });
  // Hand any rounding remainder to the largest creditor so the books balance.
  const remainder = roundMoney(raised - distributed);
  if (remainder !== 0 && payouts.length > 0) {
    const top = payouts.reduce((best, p) => (p.owed > best.owed ? p : best), payouts[0]);
    top.paid = roundMoney(top.paid + remainder);
  }
  return { bankrupt: true, raised, debt, sales, payouts, remainingCash: 0, shortfall: roundMoney(debt - raised) };
}
