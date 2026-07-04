import { useDashboard } from "./useDashboard.js";
import Header from "./components/Header.jsx";
import StrategyCard from "./components/StrategyCard.jsx";
import Lattice from "./components/Lattice.jsx";
import RidgePanel from "./components/RidgePanel.jsx";
import ForceGraph from "./components/ForceGraph.jsx";
import TradeTape from "./components/TradeTape.jsx";
import StrategyLab from "./components/StrategyLab.jsx";

export default function App() {
  const { state, connected, tape } = useDashboard();

  return (
    <div className="scanlines min-h-full">
      <Header state={state} connected={connected} />

      {!state ? (
        <div className="p-8 text-dim text-xs">connecting to dashboard server…</div>
      ) : (
        <main className="p-4 grid gap-4 xl:grid-cols-3 lg:grid-cols-2 grid-cols-1">
          {state.portfolios.map((p) => (
            <StrategyCard key={p.id} portfolio={p} minScore={state.promotionMinScore} />
          ))}

          <Lattice trades={state.trades} />
          <RidgePanel portfolios={state.portfolios} trades={state.trades} />
          <ForceGraph
            portfolios={state.portfolios}
            trades={state.trades}
            recommendations={state.recommendations}
          />

          <div className="xl:col-span-2 lg:col-span-2">
            <TradeTape tape={tape} />
          </div>

          <div className="border border-hair bg-panel p-3">
            <div className="microlabel mb-2">Notifications</div>
            <div className="overflow-y-auto max-h-64 flex flex-col gap-1">
              {state.notifications.length === 0 && (
                <div className="text-xs text-dim">no safety events</div>
              )}
              {state.notifications.map((n) => (
                <div key={n.id} className="text-[11px] border-b border-hair/50 py-0.5">
                  <span className="text-dim">{new Date(n.ts).toISOString().slice(5, 16).replace("T", " ")}</span>{" "}
                  <span className={n.type === "kill_switch" || n.type === "demotion" ? "text-down" : "text-dim"}>
                    [{n.type}]
                  </span>{" "}
                  {n.message}
                </div>
              ))}
            </div>
          </div>
        </main>
      )}

      {/* Full-width section, deliberately outside the state gate: the Lab only
          needs the HTTP endpoint, so it works even before the WS connects. */}
      <section className="p-4 pt-0">
        <StrategyLab />
      </section>
    </div>
  );
}
