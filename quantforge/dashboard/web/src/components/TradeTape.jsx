/**
 * Live trade tape: newest-first list of closed trades. Rows are appended by
 * dedicated WS "trade" messages (see useDashboard) — never by polling or
 * re-fetching the page.
 */

import { fmt, fmtSigned, utcShort, tradeReturnPct } from "../format.js";

export default function TradeTape({ tape }) {
  return (
    <div className="border border-hair bg-panel p-3 flex flex-col min-h-0">
      <div className="microlabel mb-2">Trade tape — live</div>
      <div className="overflow-y-auto max-h-64 flex flex-col gap-px">
        {tape.length === 0 && <div className="text-xs text-dim">no closed trades yet</div>}
        {tape.map((t) => (
          <div key={t.id} className="flex items-baseline gap-2 text-[11px] py-0.5 border-b border-hair/50">
            <span className="text-dim w-20 shrink-0">{utcShort(t.closed_at)}</span>
            <span className="w-40 shrink-0 truncate">{t.strategy_name}</span>
            <span className="text-dim w-20 shrink-0">{t.symbol}</span>
            <span className={`w-20 shrink-0 text-right font-bold ${t.pnl >= 0 ? "text-up" : "text-down"}`}>
              {fmtSigned(t.pnl)}
            </span>
            <span className={`w-16 shrink-0 text-right ${t.pnl >= 0 ? "text-up" : "text-down"}`}>
              {fmtSigned(tradeReturnPct(t))}%
            </span>
            <span className="text-dim truncate">
              {fmt(t.entry_price)}→{fmt(t.exit_price)} · {t.reason}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
