/**
 * Probability lattice: canvas scatter of recent closed trades across all
 * portfolios. x = per-trade return % (display-only derivation, same
 * convention as the confidence scorer's consistency calc), y = hold duration
 * in hours, color = pnl sign.
 */

import { useEffect, useRef } from "react";
import { tradeReturnPct, holdHours } from "../format.js";

export default function Lattice({ trades }) {
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

    const pts = (trades ?? []).map((t) => ({ r: tradeReturnPct(t), hrs: holdHours(t), win: t.pnl > 0 }));
    const pad = { l: 34, r: 8, t: 8, b: 18 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    const rMax = Math.max(1, ...pts.map((p) => Math.abs(p.r)));
    const hMax = Math.max(1, ...pts.map((p) => p.hrs));
    const x = (r) => pad.l + ((r + rMax) / (2 * rMax)) * iw;
    const y = (hrs) => pad.t + ih - (hrs / hMax) * ih;

    // grid + zero axis
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = pad.t + (i / 4) * ih;
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(w - pad.r, gy);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(x(0), pad.t);
    ctx.lineTo(x(0), pad.t + ih);
    ctx.stroke();

    ctx.font = "9px monospace";
    ctx.fillStyle = "#6b6b74";
    ctx.fillText(`-${rMax.toFixed(1)}%`, pad.l, h - 5);
    ctx.fillText("0", x(0) - 2, h - 5);
    ctx.fillText(`+${rMax.toFixed(1)}%`, w - pad.r - 34, h - 5);
    ctx.save();
    ctx.translate(10, pad.t + ih / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`hold h (max ${hMax.toFixed(0)})`, -30, 0);
    ctx.restore();

    for (const p of pts) {
      ctx.fillStyle = p.win ? "rgba(79,174,124,0.75)" : "rgba(194,91,91,0.75)";
      ctx.beginPath();
      ctx.arc(x(p.r), y(p.hrs), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts.length === 0) {
      ctx.fillStyle = "#6b6b74";
      ctx.font = "10px monospace";
      ctx.fillText("no closed trades yet", pad.l + 10, pad.t + ih / 2);
    }
  }, [trades]);

  return (
    <div className="border border-hair bg-panel p-3">
      <div className="microlabel mb-2">Probability lattice — return% × hold hours</div>
      <canvas ref={ref} className="w-full h-44 block" />
    </div>
  );
}
