/**
 * QUANTFORGE execution layer: shared fill math (Phase 2).
 *
 * Same fee/slippage conventions as the Phase 1 backtester, factored out so
 * the paper broker (engine) and the settlement sweep (worker) price fills
 * identically: buys fill worse (higher), sells fill worse (lower), and fees
 * are charged on the filled notional. Both parameters are in basis points.
 */

export function applySlippage(price, side, slippageBps) {
  const slip = slippageBps / 10_000;
  return side === "BUY" ? price * (1 + slip) : price * (1 - slip);
}

export function feeFor(qty, price, feeBps) {
  return qty * price * (feeBps / 10_000);
}
