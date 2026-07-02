/**
 * QUANTFORGE Phase 1 demo: backtest the example strategies against the local
 * synthetic candle fixture. Fully offline — no exchange/network access needed.
 *
 * Run with: npm run demo            (both example strategies)
 *       or: node src/execution/demo.js strategies/ema-cross-basic.json
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadFixture } from "../data/candleLoader.js";
import { loadStrategy } from "../strategy/loader.js";
import { backtest } from "./backtester.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(ROOT, "fixtures", "BTC_USDT_1h_synthetic.json");

const strategyPaths = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [
      path.join(ROOT, "strategies", "ema-cross-basic.json"),
      path.join(ROOT, "strategies", "engulfing-breakout.json"),
    ];

const fmt = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : String(x));

const candles = await loadFixture(FIXTURE);
console.log(`Loaded ${candles.length} candles from fixture ${path.relative(ROOT, FIXTURE)}\n`);

for (const strategyPath of strategyPaths) {
  const strategy = await loadStrategy(strategyPath);
  const { trades, metrics } = backtest(strategy, candles, {
    feeBps: 10,       // 0.10% per fill
    slippageBps: 5,   // 0.05% per fill
    initialCapital: 10_000,
  });

  console.log(`=== ${strategy.name} (${strategy.symbols.join(", ")} @ ${strategy.timeframe}) ===`);
  console.log(`Trades:         ${metrics.trades}`);
  for (const t of trades) {
    console.log(
      `  ${new Date(t.entryTime).toISOString().slice(0, 16)} -> ${new Date(t.exitTime)
        .toISOString()
        .slice(0, 16)}  entry ${fmt(t.entryPrice)}  exit ${fmt(t.exitPrice)}  pnl ${fmt(t.pnl)} (${fmt(
        t.returnPct
      )}%)  [${t.reason}]`
    );
  }
  console.log(`Final equity:   $${fmt(metrics.finalEquity)}`);
  console.log(`Total return:   ${fmt(metrics.totalReturnPct)}%`);
  console.log(`Win rate:       ${fmt(metrics.winRatePct, 1)}%`);
  console.log(`Sharpe ratio:   ${fmt(metrics.sharpe)}`);
  console.log(`Sortino ratio:  ${fmt(metrics.sortino)}`);
  console.log(`Max drawdown:   ${fmt(metrics.maxDrawdownPct)}%`);
  console.log(`Profit factor:  ${fmt(metrics.profitFactor)}`);
  console.log();
}
