import { useEffect, useState } from "react";
import DotMatrix from "./DotMatrix.jsx";
import { postJson } from "../useDashboard.js";
import { fmtSigned } from "../format.js";

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="text-dim text-xs">{now.toISOString().slice(0, 19).replace("T", " ")} UTC</span>;
}

function KillSwitch({ killSwitch }) {
  const engaged = killSwitch?.kill_switch_engaged === 1;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    const res = await postJson("/api/kill-switch", {
      engaged: !engaged,
      reason: !engaged ? reason || "engaged from dashboard" : null,
    }).catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (!res.ok) setError(res.error ?? "request failed");
    else {
      setOpen(false);
      setReason("");
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`border px-3 py-1.5 text-[11px] tracking-[0.14em] uppercase font-bold cursor-pointer ${
          engaged
            ? "bg-down text-black border-down qf-pulse"
            : "text-down border-down/60 hover:bg-down/10"
        }`}
      >
        {engaged ? "KILL SWITCH ENGAGED" : "KILL SWITCH"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 border border-hair bg-panel p-3 z-40">
          <div className="microlabel mb-2">{engaged ? "Disengage kill switch?" : "Engage kill switch?"}</div>
          {engaged ? (
            <div className="text-[11px] text-dim mb-2 break-words">
              engaged {killSwitch.engaged_at ? new Date(killSwitch.engaged_at).toISOString() : ""}
              {killSwitch.reason ? ` — ${killSwitch.reason}` : ""}
            </div>
          ) : (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reason (optional)"
              className="w-full border border-hair bg-black/40 px-2 py-1 mb-2 text-xs outline-none"
            />
          )}
          {error && <div className="text-down text-[11px] mb-2">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={toggle}
              disabled={busy}
              className="border border-down px-2 py-1 text-[11px] uppercase tracking-[0.12em] bg-down/20 text-down hover:bg-down/30 cursor-pointer"
            >
              {engaged ? "Disengage" : "Engage"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="border border-hair px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-dim cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Header({ state, connected }) {
  const portfolios = state?.portfolios ?? [];
  const liveCount = portfolios.filter((p) => p.status === "live").length;
  // Presentation math only: stored latest snapshot equity minus stored
  // initial cash, summed for the headline dot-matrix P&L readout.
  const totalPnl = portfolios.reduce(
    (s, p) => s + ((p.latestSnapshot?.equity ?? p.initial_cash) - p.initial_cash),
    0
  );

  return (
    <header className="flex items-center gap-5 px-4 py-3 border-b border-hair bg-panel sticky top-0 z-30">
      <div className="text-base font-bold tracking-[0.3em]">QUANTFORGE</div>

      <span
        className={`qf-pulse px-2 py-0.5 text-[10px] font-bold tracking-[0.18em] border ${
          liveCount > 0 ? "text-up border-up/70" : "text-amber border-amber/70"
        }`}
      >
        {liveCount > 0 ? `LIVE ×${liveCount}` : "PAPER"}
      </span>

      <div
        className="flex items-center gap-2"
        title={connected ? "WebSocket connected" : "WebSocket disconnected — reconnecting"}
      >
        <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-up" : "bg-down qf-pulse"}`} />
        <span className="microlabel">{connected ? "WS LINK" : "WS DOWN"}</span>
      </div>

      <div className="flex items-center gap-4 ml-auto">
        <div className="flex items-center gap-2">
          <span className="microlabel">Σ P&amp;L $</span>
          <DotMatrix text={fmtSigned(totalPnl)} color={totalPnl >= 0 ? "#4fae7c" : "#c25b5b"} />
        </div>
        <UtcClock />
        <KillSwitch killSwitch={state?.killSwitch} />
      </div>
    </header>
  );
}
