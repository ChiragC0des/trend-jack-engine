/**
 * Year-scale backtest + failure diagnosis over a real historical fixture.
 *
 *   node scripts/backtest-year.js [fixture] [strategyFile...]
 *
 * Defaults: fixtures/BTC_USD_1h_2017_bitfinex.json (real Bitfinex BTC/USD
 * minute data resampled to 1h — see README "Historical fixtures") against
 * every non-versioned strategy in /strategies plus any .v2 files.
 *
 * Beyond the backtester's own metrics this prints, per strategy:
 *   - buy & hold comparison over the same candles
 *   - monthly P&L vs the market's monthly move and an efficiency ratio
 *     (|net move| / sum |hourly moves| — low = chop), to localize WHERE
 *     the rules lose money, not just how much
 *   - exit-reason breakdown (stop_loss / take_profit / exit_rules) with pnl
 *   - worst trades, longest losing streak, max-drawdown window with dates
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStrategy } from "../src/strategy/loader.js";
import { normalizeCandles } from "../src/data/candleLoader.js";
import { backtest } from "../src/execution/backtester.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fixturePath = args[0] ?? path.join(ROOT, "fixtures", "BTC_USD_1h_2017_bitfinex.json");
const strategyPaths = args.length > 1
  ? args.slice(1)
  : fs.readdirSync(path.join(ROOT, "strategies")).filter((f) => f.endsWith(".json")).sort()
      .map((f) => path.join(ROOT, "strategies", f));

const candles = normalizeCandles(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
const first = candles[0];
const last = candles[candles.length - 1];
const buyHoldPct = ((last.close - first.open) / first.open) * 100;

const month = (ts) => new Date(ts).toISOString().slice(0, 7);
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const usd = (x) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;

// Market shape per month: return + efficiency ratio (low ER = chop).
const monthly = new Map();
for (let i = 0; i < candles.length; i++) {
  const m = month(candles[i].timestamp);
  let row = monthly.get(m);
  if (!row) { row = { open: candles[i].open, close: candles[i].close, pathLen: 0 }; monthly.set(m, row); }
  row.close = candles[i].close;
  if (i > 0) row.pathLen += Math.abs(candles[i].close - candles[i - 1].close);
}
for (const row of monthly.values()) {
  row.retPct = ((row.close - row.open) / row.open) * 100;
  row.er = row.pathLen > 0 ? Math.abs(row.close - row.open) / row.pathLen : 0;
}

console.log(`\nfixture: ${path.relative(ROOT, fixturePath)}`);
console.log(`candles: ${candles.length}  ${new Date(first.timestamp).toISOString().slice(0, 10)} -> ${new Date(last.timestamp).toISOString().slice(0, 10)}`);
console.log(`buy & hold: ${first.open.toFixed(2)} -> ${last.close.toFixed(2)} = ${pct(buyHoldPct)}\n`);

for (const strategyPath of strategyPaths) {
  const strategy = await loadStrategy(strategyPath);
  const declared = `${strategy.symbols.join(",")} ${strategy.timeframe}`;
  const { trades, equityCurve, metrics } = backtest(strategy, candles, {
    log: { warn: () => {}, info: () => {} },
  });

  console.log("=".repeat(78));
  console.log(`${strategy.name}   (declared for ${declared}; run against this fixture's series)`);
  console.log("=".repeat(78));
  console.log(
    `return ${pct(metrics.totalReturnPct)} (final $${metrics.finalEquity.toFixed(2)})  vs buy&hold ${pct(buyHoldPct)}` +
    `\ntrades ${metrics.trades}  win rate ${metrics.winRatePct.toFixed(1)}%  profit factor ${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "inf"}` +
    `  sharpe ${metrics.sharpe.toFixed(2)}  sortino ${metrics.sortino.toFixed(2)}  max DD ${metrics.maxDrawdownPct.toFixed(1)}%`
  );

  if (trades.length === 0) { console.log("\n(no trades — rules never fired on this data)\n"); continue; }

  // Exit reasons
  const reasons = new Map();
  for (const t of trades) {
    const r = reasons.get(t.reason) ?? { n: 0, pnl: 0 };
    r.n++; r.pnl += t.pnl; reasons.set(t.reason, r);
  }
  console.log("\nexit reasons:");
  for (const [reason, r] of [...reasons].sort((a, b) => a[1].pnl - b[1].pnl)) {
    console.log(`  ${reason.padEnd(12)} x${String(r.n).padEnd(4)} net ${usd(r.pnl)}`);
  }

  // Monthly P&L vs market shape
  const byMonth = new Map();
  for (const t of trades) {
    const m = month(t.exitTime);
    const row = byMonth.get(m) ?? { pnl: 0, n: 0 };
    row.pnl += t.pnl; row.n++; byMonth.set(m, row);
  }
  console.log("\nmonth      strat pnl      trades   market     efficiency(ER)");
  for (const [m, mk] of monthly) {
    const s = byMonth.get(m) ?? { pnl: 0, n: 0 };
    const flag = s.pnl < 0 && mk.er < 0.1 ? "  <- lost in chop" : s.pnl < 0 ? "  <- lost" : "";
    console.log(
      `  ${m}   ${usd(s.pnl).padStart(10)}   ${String(s.n).padStart(4)}     ${pct(mk.retPct).padStart(8)}   ${mk.er.toFixed(3)}${flag}`
    );
  }

  // Worst trades
  const worst = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
  console.log("\nworst trades:");
  for (const t of worst) {
    console.log(
      `  ${day(t.entryTime)} -> ${day(t.exitTime)}  ${usd(t.pnl)} (${pct(t.returnPct)})  entry ${t.entryPrice.toFixed(0)} exit ${t.exitPrice.toFixed(0)}  [${t.reason}]`
    );
  }

  // Longest losing streak
  let streak = 0, bestStreak = 0, streakPnl = 0, worstStreakPnl = 0, streakStart = null, worstWindow = null;
  for (const t of trades) {
    if (t.pnl <= 0) {
      if (streak === 0) streakStart = t.entryTime;
      streak++; streakPnl += t.pnl;
      if (streak > bestStreak || (streak === bestStreak && streakPnl < worstStreakPnl)) {
        bestStreak = streak; worstStreakPnl = streakPnl; worstWindow = [streakStart, t.exitTime];
      }
    } else { streak = 0; streakPnl = 0; }
  }
  if (worstWindow) {
    console.log(`\nlongest losing streak: ${bestStreak} trades, ${usd(worstStreakPnl)} (${day(worstWindow[0])} -> ${day(worstWindow[1])})`);
  }

  // Max drawdown window
  let peak = -Infinity, peakTs = 0, maxDd = 0, ddFrom = 0, ddTo = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) { peak = p.equity; peakTs = p.timestamp; }
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) { maxDd = dd; ddFrom = peakTs; ddTo = p.timestamp; }
  }
  console.log(`max drawdown window: ${(maxDd * 100).toFixed(1)}% from ${day(ddFrom)} to ${day(ddTo)}`);

  // Time in market
  const hoursHeld = trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / 3_600_000;
  console.log(`time in market: ${((hoursHeld / candles.length) * 100).toFixed(1)}% of the year (${hoursHeld.toFixed(0)}h over ${trades.length} trades)\n`);
}
