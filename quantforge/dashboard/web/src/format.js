/** Presentation-only helpers. No financial metrics are computed client-side
 *  beyond display math on values already stored by the backend. */

export const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");

export const fmtMoney = (x) =>
  Number.isFinite(x) ? (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(2) : "—";

export const fmtSigned = (x, d = 2) =>
  Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "—";

/** Display-only per-trade return on capital deployed — same convention as the
 *  confidence scorer's consistency calc (pnl / (entry notional + fees)).
 *  Used purely for plotting; never stored, never fed back into any metric. */
export const tradeReturnPct = (t) => {
  const base = t.qty * t.entry_price + t.fees;
  return base > 0 ? (t.pnl / base) * 100 : 0;
};

export const holdHours = (t) => (t.closed_at - t.opened_at) / 3_600_000;

export const utcTime = (ts) => new Date(ts).toISOString().slice(11, 19);
export const utcShort = (ts) => new Date(ts).toISOString().slice(5, 16).replace("T", " ");
