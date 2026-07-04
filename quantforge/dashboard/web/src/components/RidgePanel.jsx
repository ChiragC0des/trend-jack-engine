/**
 * Ridge panel: one small filled return-distribution curve per strategy,
 * stacked. The histogram + gaussian-kernel smoothing below is PRESENTATION
 * ONLY — visual bucketing of the per-trade display returns, not a stored or
 * authoritative metric anywhere in the system.
 */

import { useEffect, useRef } from "react";
import { tradeReturnPct } from "../format.js";

const BINS = 36;

function density(returns, lo, hi) {
  // simple KDE-ish smoothing: histogram then a small gaussian blur over bins
  const hist = new Array(BINS).fill(0);
  const span = hi - lo || 1;
  for (const r of returns) {
    const i = Math.max(0, Math.min(BINS - 1, Math.floor(((r - lo) / span) * BINS)));
    hist[i] += 1;
  }
  const kernel = [0.06, 0.24, 0.4, 0.24, 0.06];
  const smooth = hist.map((_, i) =>
    kernel.reduce((s, k, j) => s + k * (hist[i + j - 2] ?? 0), 0)
  );
  const max = Math.max(...smooth, 1e-9);
  return smooth.map((v) => v / max);
}

export default function RidgePanel({ portfolios, trades }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const byStrategy = portfolios.map((p) => ({
      name: p.strategy_name,
      returns: (trades ?? []).filter((t) => t.portfolio_id === p.id).map(tradeReturnPct),
    }));
    const all = byStrategy.flatMap((s) => s.returns);
    const bound = Math.max(1, ...all.map(Math.abs));
    const lo = -bound;
    const hi = bound;

    const rows = byStrategy.length || 1;
    const rowH = h / rows;
    const ridgeH = rowH * 0.72;

    byStrategy.forEach((s, idx) => {
      const baseY = rowH * (idx + 1) - 6;
      const net = s.returns.reduce((a, b) => a + b, 0);
      const color = s.returns.length === 0 ? "#6b6b74" : net >= 0 ? "#4fae7c" : "#c25b5b";

      // zero line marker
      const x0 = ((0 - lo) / (hi - lo)) * w;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(x0, baseY - ridgeH);
      ctx.lineTo(x0, baseY);
      ctx.stroke();

      if (s.returns.length > 0) {
        const d = density(s.returns, lo, hi);
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        d.forEach((v, i) => {
          const x = ((i + 0.5) / BINS) * w;
          ctx.lineTo(x, baseY - v * ridgeH);
        });
        ctx.lineTo(w, baseY);
        ctx.closePath();
        ctx.fillStyle = color + "33";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        ctx.lineTo(w, baseY);
        ctx.stroke();
      }

      ctx.fillStyle = "#6b6b74";
      ctx.font = "9px monospace";
      ctx.fillText(
        `${s.name} (${s.returns.length} trades)`.toUpperCase(),
        4,
        baseY - ridgeH - 3
      );
    });
  }, [portfolios, trades]);

  return (
    <div className="border border-hair bg-panel p-3">
      <div className="microlabel mb-2">Return distributions — display-side smoothing</div>
      <canvas ref={ref} className="w-full h-44 block" />
    </div>
  );
}
