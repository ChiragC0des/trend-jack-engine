import { useEffect, useRef, useState } from "react";
import { postJson } from "../useDashboard.js";
import { fmt, fmtSigned } from "../format.js";

const PLACEHOLDER =
  'e.g. "go long when EMA 9 crosses above EMA 21 and RSI is under 60; exit on the reverse cross; 3% stop, 8% target on BTC/USDT 1h" — or paste Pine Script';

const FIXTURES = [
  { key: "2017", label: "2017 REAL" },
  { key: "synthetic", label: "SYNTHETIC" },
];

/** Equity-curve chart: area + line + endpoint marker over the server's
 *  downsampled curve, with a hover crosshair. Pure presentation — every
 *  number plotted comes from the backtester response as-is. */
function EquityChart({ curve }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null); // index into curve

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !curve?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const eq = curve.map((p) => p.equity);
    const initial = eq[0];
    const min = Math.min(...eq);
    const max = Math.max(...eq);
    const span = max - min || 1;
    const padL = 6, padR = 10, padT = 8, padB = 14;
    const x = (i) => padL + (i / (eq.length - 1)) * (w - padL - padR);
    const y = (v) => h - padB - ((v - min) / span) * (h - padT - padB);
    const up = eq[eq.length - 1] >= initial;
    const color = up ? "#4fae7c" : "#c25b5b";

    // dashed baseline at starting equity (same idiom as the card sparklines)
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y(initial));
    ctx.lineTo(w - padR, y(initial));
    ctx.stroke();
    ctx.setLineDash([]);

    // area fill under the line
    ctx.beginPath();
    eq.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.lineTo(x(eq.length - 1), h - padB);
    ctx.lineTo(x(0), h - padB);
    ctx.closePath();
    ctx.fillStyle = up ? "rgba(79,174,124,0.10)" : "rgba(194,91,91,0.10)";
    ctx.fill();

    // line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    eq.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.stroke();

    // endpoint marker with a panel-colored ring so it reads over the line
    const ex = x(eq.length - 1), ey = y(eq[eq.length - 1]);
    ctx.fillStyle = "#101012";
    ctx.beginPath();
    ctx.arc(ex, ey, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ex, ey, 3, 0, Math.PI * 2);
    ctx.fill();

    // min/max scale hints
    ctx.fillStyle = "#6b6b74";
    ctx.font = "9px monospace";
    ctx.fillText(`$${Math.round(max)}`, padL, padT + 2);
    ctx.fillText(`$${Math.round(min)}`, padL, h - 3);

    // hover crosshair + readout
    if (hover != null && curve[hover]) {
      const hx = x(hover), hv = curve[hover];
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, h - padB);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hx, y(hv.equity), 2.5, 0, Math.PI * 2);
      ctx.fill();
      const text = `${new Date(hv.t).toISOString().slice(0, 10)}  $${hv.equity.toFixed(2)}`;
      ctx.font = "10px monospace";
      const tw = ctx.measureText(text).width;
      const tx = Math.min(Math.max(hx - tw / 2, padL), w - padR - tw);
      ctx.fillStyle = "#c9c9cf";
      ctx.fillText(text, tx, padT + 2);
    }
  }, [curve, hover]);

  const onMove = (e) => {
    if (!curve?.length) return;
    const rect = ref.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left - 6) / (rect.width - 16);
    setHover(Math.max(0, Math.min(curve.length - 1, Math.round(frac * (curve.length - 1)))));
  };

  return (
    <canvas
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      className="w-full h-44 block cursor-crosshair"
    />
  );
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className="border border-hair bg-black/20 p-2 text-center">
      <div className="microlabel">{label}</div>
      <div className={`text-sm font-bold ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

export default function StrategyLab() {
  const [text, setText] = useState("");
  const [fixture, setFixture] = useState("2017");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await postJson("/api/strategy/lab", { description: text, fixture }).catch(
      (e) => ({ ok: false, error: e.message })
    );
    setBusy(false);
    if (!res.ok) {
      setResult(null);
      setError(res.error ?? "request failed");
    } else {
      setResult(res);
    }
  };

  const m = result?.metrics;
  const beatMarket = m != null && m.totalReturnPct >= result.buyHoldPct;

  return (
    <div className="border border-hair bg-panel p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="microlabel">Strategy Lab</span>
        <span className="text-[10px] text-dim">
          plain English or Pine → schema-validated strategy → real fixture backtest · advisory only
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={3}
        spellCheck={false}
        className="w-full border border-hair bg-black/40 px-2 py-1.5 text-xs outline-none focus:border-up/60 resize-y"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <span className="microlabel">Backtest data</span>
        {FIXTURES.map((f) => (
          <button
            key={f.key}
            onClick={() => setFixture(f.key)}
            className={`border px-2 py-1 text-[10px] tracking-[0.12em] cursor-pointer ${
              fixture === f.key ? "border-up/70 text-up bg-up/10" : "border-hair text-dim hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className="ml-auto border border-up text-up px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] font-bold hover:bg-up/10 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? "Synthesizing…" : "Synthesize & Backtest"}
        </button>
      </div>

      {busy && <div className="text-[11px] text-amber qf-pulse">translating → validating → backtesting…</div>}

      {error && (
        <div className="text-[11px] text-down border border-down/50 bg-down/5 p-2 break-words whitespace-pre-wrap">
          REJECTED — {error}
        </div>
      )}

      {result && !busy && (
        <>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-bold">{result.strategy.name}</span>
            <span className="text-[10px] text-dim">
              {result.strategy.symbols?.join(" ")} {result.strategy.timeframe} · {result.tradeCount} trades over{" "}
              {result.candles} candles · {result.fixtureLabel}
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <Tile
              label="Return"
              value={`${fmtSigned(m.totalReturnPct)}%`}
              sub={`B&H ${fmtSigned(result.buyHoldPct)}%`}
              tone={m.totalReturnPct >= 0 ? "text-up" : "text-down"}
            />
            <Tile label="Win rate" value={`${fmt(m.winRatePct, 1)}%`} sub={`${m.trades} trades`} />
            <Tile label="Profit factor" value={m.profitFactor == null ? "∞" : fmt(m.profitFactor)} />
            <Tile label="Sharpe" value={fmt(m.sharpe)} />
            <Tile label="Sortino" value={fmt(m.sortino)} />
            <Tile label="Max DD" value={`${fmt(m.maxDrawdownPct, 1)}%`} tone="text-amber" />
          </div>

          <div className="border border-hair bg-black/20">
            <EquityChart curve={result.equityCurve} />
          </div>
          <div className="text-[10px] text-dim">
            equity from $10,000 · final ${fmt(m.finalEquity)} ({fmtSigned(m.totalReturnPct)}%) ·{" "}
            {beatMarket ? "beat" : "trailed"} buy&amp;hold ({fmtSigned(result.buyHoldPct)}% over the same candles)
          </div>

          <details className="text-xs">
            <summary className="microlabel cursor-pointer select-none">Generated strategy JSON</summary>
            <pre className="mt-2 border border-hair bg-black/40 p-2 max-h-64 overflow-auto text-[11px] leading-snug">
              {JSON.stringify(result.strategy, null, 2)}
            </pre>
          </details>
        </>
      )}

      <div className="text-[10px] text-dim border-t border-hair/50 pt-2">
        This is the generate → backtest step. Before any live order this strategy must still paper-trade, clear
        confidence ≥ 75, be promoted with a typed confirmation, and pass the Phase 6 gauntlet. Nothing here places a
        trade.
      </div>
    </div>
  );
}
