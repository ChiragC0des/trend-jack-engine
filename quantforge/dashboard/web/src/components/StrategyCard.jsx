import { useEffect, useRef, useState } from "react";
import { postJson } from "../useDashboard.js";
import { fmt, fmtSigned } from "../format.js";

/** Equity sparkline: plots the worker's stored snapshot equity values as-is. */
function Sparkline({ snapshots, initialCash }) {
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
    if (!snapshots || snapshots.length < 2) {
      ctx.fillStyle = "#6b6b74";
      ctx.font = "10px monospace";
      ctx.fillText("awaiting snapshots…", 6, h / 2);
      return;
    }
    const eq = snapshots.map((s) => s.equity);
    const min = Math.min(...eq, initialCash);
    const max = Math.max(...eq, initialCash);
    const span = max - min || 1;
    const x = (i) => (i / (eq.length - 1)) * (w - 4) + 2;
    const y = (v) => h - 3 - ((v - min) / span) * (h - 6);

    // baseline at initial cash
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(initialCash));
    ctx.lineTo(w, y(initialCash));
    ctx.stroke();
    ctx.setLineDash([]);

    const up = eq[eq.length - 1] >= initialCash;
    ctx.strokeStyle = up ? "#4fae7c" : "#c25b5b";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    eq.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.stroke();
  }, [snapshots, initialCash]);
  return <canvas ref={ref} className="w-full h-16 block" />;
}

/** Segmented 0-100 confidence meter; amber below the gate, green at/above. */
function ConfidenceMeter({ confidence, minScore }) {
  const score = confidence?.score ?? null;
  const eligible = score != null && score >= minScore;
  const color = eligible ? "bg-up" : "bg-amber";
  const segments = 20; // 5 points each
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="microlabel">Confidence</span>
        <span className="flex items-center gap-2">
          {confidence?.capped === 1 && (
            <span className="text-[9px] font-bold tracking-[0.12em] text-amber border border-amber/70 px-1">
              CAPPED
            </span>
          )}
          <span className={`text-xs font-bold ${eligible ? "text-up" : "text-amber"}`}>
            {score != null ? `${score}/100` : "—"}
          </span>
        </span>
      </div>
      <div className="flex gap-[2px]">
        {Array.from({ length: segments }, (_, i) => {
          const on = score != null && score >= ((i + 1) * 100) / segments;
          return <span key={i} className={`h-2 flex-1 ${on ? color : "bg-white/10"}`} />;
        })}
      </div>
    </div>
  );
}

function PromoteModal({ portfolio, onClose }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, error?, portfolio? }

  const submit = async () => {
    setBusy(true);
    const res = await postJson("/api/promote", {
      strategyName: portfolio.strategy_name,
      typedConfirmation: typed,
    }).catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    setResult(res);
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="w-[28rem] max-w-[92vw] border border-hair bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="microlabel mb-3">Promote to live</div>
        <p className="text-xs text-dim mb-3">
          Promoting <span className="text-ink font-bold">{portfolio.strategy_name}</span> flips this portfolio to
          LIVE status. Type the strategy name EXACTLY (case-sensitive) to confirm.
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={portfolio.strategy_name}
          className="w-full border border-hair bg-black/40 px-2 py-1.5 mb-3 text-xs outline-none focus:border-up/60"
        />
        {/* Safety UI: the server's verdict is shown verbatim, especially the
            exact gate reason on rejection. */}
        {result && (
          <div
            className={`text-xs mb-3 border p-2 break-words ${
              result.ok ? "text-up border-up/50 bg-up/5" : "text-down border-down/50 bg-down/5"
            }`}
          >
            {result.ok
              ? `PROMOTED — status: ${result.portfolio.status}, capital cap $${result.portfolio.live_capital_cap}`
              : `REJECTED — ${result.error}`}
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={busy || result?.ok}
            className="border border-up text-up px-3 py-1.5 text-[11px] uppercase tracking-[0.12em] font-bold hover:bg-up/10 disabled:opacity-40 cursor-pointer"
          >
            Promote
          </button>
          <button
            onClick={onClose}
            className="border border-hair text-dim px-3 py-1.5 text-[11px] uppercase tracking-[0.12em] cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StrategyCard({ portfolio, minScore }) {
  const [modal, setModal] = useState(false);
  const c = portfolio.confidence;
  const equity = portfolio.latestSnapshot?.equity ?? portfolio.initial_cash;
  const returnPct = (equity / portfolio.initial_cash - 1) * 100; // display math on stored equity
  const live = portfolio.status === "live";
  const eligible = c != null && c.score >= minScore;

  return (
    <div className="border border-hair bg-panel p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-bold text-sm">{portfolio.strategy_name}</span>
        <span
          className={`px-1.5 py-0.5 text-[9px] font-bold tracking-[0.15em] border ${
            live ? "text-up border-up/70 qf-pulse" : "text-amber border-amber/70"
          }`}
        >
          {live ? "LIVE" : "PAPER"}
        </span>
        <span className="ml-auto text-xs text-dim">
          {portfolio.strategyMeta?.symbols?.join(" ") ?? ""} {portfolio.strategyMeta?.timeframe ?? ""}
        </span>
      </div>

      <Sparkline snapshots={portfolio.snapshots} initialCash={portfolio.initial_cash} />

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="microlabel">Return</div>
          <div className={`text-xs font-bold ${returnPct >= 0 ? "text-up" : "text-down"}`}>
            {fmtSigned(returnPct)}%
          </div>
        </div>
        {/* Win-rate + Sharpe sub-scores straight from the stored
            confidence_scores breakdown — nothing recomputed client-side. */}
        <div>
          <div className="microlabel">WR score</div>
          <div className="text-xs">{c ? `${fmt(c.win_rate_score, 1)}/20` : "—"}</div>
        </div>
        <div>
          <div className="microlabel">Sharpe score</div>
          <div className="text-xs">{c ? `${fmt(c.sharpe_score, 1)}/20` : "—"}</div>
        </div>
        <div>
          <div className="microlabel">Trades</div>
          <div className="text-xs">{c ? c.trades_count : "—"}</div>
        </div>
      </div>

      <ConfidenceMeter confidence={c} minScore={minScore} />

      <div className="flex items-center gap-2">
        <button
          onClick={() => setModal(true)}
          disabled={!eligible || live}
          title={
            live
              ? "already live"
              : eligible
                ? "open promotion confirmation"
                : `requires confidence ≥ ${minScore} (current ${c?.score ?? "none"})`
          }
          className="border border-up/70 text-up px-3 py-1 text-[10px] uppercase tracking-[0.15em] font-bold hover:bg-up/10 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          Promote
        </button>
        <span className="text-[10px] text-dim">
          equity ${fmt(equity)} · cash ${fmt(portfolio.cash)} · {portfolio.openPositions} open pos
        </span>
      </div>

      {modal && <PromoteModal portfolio={portfolio} onClose={() => setModal(false)} />}
    </div>
  );
}
