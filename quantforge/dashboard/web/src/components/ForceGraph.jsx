/**
 * Relationship graph (d3-force): strategy nodes, the symbols they trade
 * (from the strategy files' `symbols`, exposed by the state API), and recent
 * AI recommendations as "signal" nodes linked to their strategy.
 *
 * HONESTY NOTE: strategy node color is a realized-pnl-trend proxy — the net
 * pnl of that portfolio's most recent trades (green-ish positive, red-ish
 * negative, grey with no trades). The system has NO sentiment/bias score and
 * this coloring must not be read as one; the legend says so in the UI.
 */

import { useMemo } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force";

const W = 460;
const H = 280;
const RECENT_TRADES_N = 10;

const SIGNAL_COLORS = { analysis: "#7d9fc4", operation: "#b48ec4", note: "#8f8f97" };

export default function ForceGraph({ portfolios, trades, recommendations }) {
  const { nodes, links } = useMemo(() => {
    const nodes = [];
    const links = [];
    const byId = new Map();
    const add = (node) => {
      if (!byId.has(node.id)) {
        byId.set(node.id, node);
        nodes.push(node);
      }
      return byId.get(node.id);
    };

    for (const p of portfolios) {
      // realized-pnl-trend proxy (NOT sentiment — see header comment)
      const recent = trades.filter((t) => t.portfolio_id === p.id).slice(0, RECENT_TRADES_N);
      const net = recent.reduce((s, t) => s + t.pnl, 0);
      const color = recent.length === 0 ? "#6b6b74" : net >= 0 ? "#4fae7c" : "#c25b5b";
      add({ id: `s:${p.strategy_name}`, kind: "strategy", label: p.strategy_name, color, r: 14 });
      for (const symbol of p.strategyMeta?.symbols ?? []) {
        add({ id: `m:${symbol}`, kind: "symbol", label: symbol, color: "#c9c9cf", r: 9 });
        links.push({ source: `s:${p.strategy_name}`, target: `m:${symbol}` });
      }
    }
    for (const rec of recommendations ?? []) {
      if (!rec.strategy_name || !byId.has(`s:${rec.strategy_name}`)) continue;
      add({
        id: `r:${rec.id}`,
        kind: "signal",
        label: rec.type,
        title: rec.title,
        color: SIGNAL_COLORS[rec.type] ?? "#8f8f97",
        r: 5,
      });
      links.push({ source: `r:${rec.id}`, target: `s:${rec.strategy_name}` });
    }

    // Static layout: run the simulation to (near) convergence synchronously —
    // topology changes rarely, so no animation loop is needed.
    const sim = forceSimulation(nodes)
      .force("link", forceLink(links).id((d) => d.id).distance(55))
      .force("charge", forceManyBody().strength(-160))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide().radius((d) => d.r + 6))
      .stop();
    for (let i = 0; i < 250; i++) sim.tick();
    const clampX = (x) => Math.max(18, Math.min(W - 18, x));
    const clampY = (y) => Math.max(14, Math.min(H - 14, y));
    for (const n of nodes) {
      n.x = clampX(n.x);
      n.y = clampY(n.y);
    }
    return { nodes, links };
  }, [
    // re-layout only when topology or node colors change, not on every push
    JSON.stringify(
      portfolios.map((p) => [p.strategy_name, p.strategyMeta?.symbols]).concat(
        (recommendations ?? []).map((r) => r.id),
        portfolios.map((p) => {
          const recent = trades.filter((t) => t.portfolio_id === p.id).slice(0, RECENT_TRADES_N);
          return Math.sign(recent.reduce((s, t) => s + t.pnl, 0)) * Math.min(recent.length, 1);
        })
      )
    ),
  ]);

  return (
    <div className="border border-hair bg-panel p-3">
      <div className="microlabel mb-2">Relationship graph — strategies · symbols · AI signals</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {links.map((l, i) => (
          <line
            key={i}
            x1={l.source.x}
            y1={l.source.y}
            x2={l.target.x}
            y2={l.target.y}
            stroke="rgba(255,255,255,0.14)"
            strokeWidth="1"
          />
        ))}
        {nodes.map((n) => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.color + "22"} stroke={n.color} strokeWidth="1">
              {n.title && <title>{n.title}</title>}
            </circle>
            <text
              x={n.x}
              y={n.y + n.r + 9}
              textAnchor="middle"
              fontSize="8"
              fill="#8f8f97"
              fontFamily="inherit"
            >
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      <div className="text-[9px] text-dim mt-1 leading-relaxed">
        <span className="text-up">●</span> / <span className="text-down">●</span> strategy color = net realized
        pnl of last {RECENT_TRADES_N} trades (a realized-pnl-trend proxy — NOT a sentiment/bias score; no such
        score exists). Signals: <span style={{ color: SIGNAL_COLORS.analysis }}>analysis</span> ·{" "}
        <span style={{ color: SIGNAL_COLORS.operation }}>operation</span> ·{" "}
        <span style={{ color: SIGNAL_COLORS.note }}>note</span>
      </div>
    </div>
  );
}
