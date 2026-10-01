/**
 * Constant-product AMM (§2). Each stock has a pool of cash C and shares S.
 *   price = C / S,  k = C × S (constant between trades)
 * Pure functions only: the server uses them to execute trades, the client
 * uses the same code to preview them.
 */

export interface Pool {
  poolCash: number;
  poolShares: number;
}

export interface BuyQuote {
  side: "buy";
  /** Total cash the player spends (fee included). */
  grossCash: number;
  fee: number;
  /** Cash that enters the pool (grossCash − fee). */
  netToPool: number;
  shares: number;
  priceBefore: number;
  priceAfter: number;
  /** Average price paid per share including fee. */
  avgPrice: number;
  newPoolCash: number;
  newPoolShares: number;
}

export interface SellQuote {
  side: "sell";
  shares: number;
  /** Cash leaving the pool before fee. */
  grossCash: number;
  fee: number;
  /** Cash the player receives (grossCash − fee). */
  netCash: number;
  priceBefore: number;
  priceAfter: number;
  avgPrice: number;
  newPoolCash: number;
  newPoolShares: number;
}

export function poolPrice(pool: Pool): number {
  return pool.poolCash / pool.poolShares;
}

function assertPool(pool: Pool) {
  if (!(pool.poolCash > 0) || !(pool.poolShares > 0)) throw new Error("Pool is empty");
}

/**
 * Buy with `grossCash` total spend. The fee is taken off the top before the
 * remainder hits the pool math:  C' = C + Δc,  S' = k / C'.
 */
export function quoteBuy(pool: Pool, grossCash: number, feePct: number): BuyQuote {
  assertPool(pool);
  if (!(grossCash > 0) || !Number.isFinite(grossCash)) throw new Error("Amount must be positive");
  const k = pool.poolCash * pool.poolShares;
  const fee = grossCash * feePct;
  const netToPool = grossCash - fee;
  const newPoolCash = pool.poolCash + netToPool;
  const newPoolShares = k / newPoolCash;
  const shares = pool.poolShares - newPoolShares;
  return {
    side: "buy",
    grossCash,
    fee,
    netToPool,
    shares,
    priceBefore: poolPrice(pool),
    priceAfter: newPoolCash / newPoolShares,
    avgPrice: grossCash / shares,
    newPoolCash,
    newPoolShares,
  };
}

/**
 * Sell `shares`:  S' = S + Δs,  C' = k / S',  cash = C − C', then fee is
 * deducted from that cash.
 */
export function quoteSell(pool: Pool, shares: number, feePct: number): SellQuote {
  assertPool(pool);
  if (!(shares > 0) || !Number.isFinite(shares)) throw new Error("Shares must be positive");
  const k = pool.poolCash * pool.poolShares;
  const newPoolShares = pool.poolShares + shares;
  const newPoolCash = k / newPoolShares;
  const grossCash = pool.poolCash - newPoolCash;
  const fee = grossCash * feePct;
  const netCash = grossCash - fee;
  return {
    side: "sell",
    shares,
    grossCash,
    fee,
    netCash,
    priceBefore: poolPrice(pool),
    priceAfter: newPoolCash / newPoolShares,
    avgPrice: netCash / shares,
    newPoolCash,
    newPoolShares,
  };
}

/**
 * §2.1: pool cash required so a buy of (targetTradeSize × avgNetWorth) moves
 * price by targetImpact.  After a buy of Δc, price scales by (1 + Δc/C)², so
 *   C_target = Δc / (√(1 + targetImpact) − 1)
 */
export function targetPoolCash(avgNetWorth: number, targetTradeSize: number, targetImpact: number): number {
  const deltaC = targetTradeSize * avgNetWorth;
  return deltaC / (Math.sqrt(1 + targetImpact) - 1);
}

/** Pool sized for a brand-new listing at `price`. */
export function listingPool(avgNetWorth: number, price: number, targetTradeSize: number, targetImpact: number): Pool {
  const poolCash = targetPoolCash(avgNetWorth, targetTradeSize, targetImpact);
  return { poolCash, poolShares: poolCash / price };
}

export interface TopUp {
  addCash: number;
  addShares: number;
  newPoolCash: number;
  newPoolShares: number;
}

/**
 * Weekly maintenance: if the pool's cash is below target, add cash and shares
 * in the ratio that keeps price unchanged (ΔS = ΔC / price). Never shrinks.
 */
export function topUpPool(pool: Pool, targetCash: number): TopUp {
  const price = poolPrice(pool);
  const addCash = Math.max(0, targetCash - pool.poolCash);
  const addShares = addCash / price;
  return {
    addCash,
    addShares,
    newPoolCash: pool.poolCash + addCash,
    newPoolShares: pool.poolShares + addShares,
  };
}
