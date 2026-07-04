/**
 * QUANTFORGE dashboard server (Phase 5): Express + WebSocket.
 *
 * The THIRD OS process in the architecture (engine, worker, dashboard). It
 * opens the same SQLite file (WAL) as a reader and has exactly TWO write
 * paths, both explicit human-triggered actions that call the already-built
 * Phase 3 functions verbatim:
 *
 *   POST /api/promote      -> promote()        (src/confidence/promotion.js)
 *   POST /api/kill-switch  -> setKillSwitch()  (src/confidence/killSwitch.js)
 *
 * Everything else is read-only. Clients never poll: the server polls the DB
 * internally (cheap reads every POLL_MS) and pushes over WebSocket only when
 * the payload actually changed; new trades are additionally pushed as small
 * dedicated "trade" messages (a diff of trades.max(id)) so the UI appends
 * tape lines without re-rendering everything.
 */

import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { openDb } from "../../src/db/index.js";
import { promote } from "../../src/confidence/promotion.js";
import { setKillSwitch } from "../../src/confidence/killSwitch.js";
import { readState, tradesSince, maxTradeId } from "./state.js";
import { runStrategyLab, LabInputError, LabTranslationError } from "./strategyLab.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(HERE, "..", "web", "dist");

export const DEFAULT_DASHBOARD_PORT = 4100;
const POLL_MS = 750;

export function createDashboardServer({ dbPath, port = DEFAULT_DASHBOARD_PORT, log = console } = {}) {
  const db = openDb(dbPath);
  const app = express();
  app.use(express.json());

  // --- Read-only state ---
  app.get("/api/state", (req, res) => {
    try {
      res.json(readState(db));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- Write path 1 of 2: promotion (real Phase 3 gate, errors surfaced) ---
  app.post("/api/promote", (req, res) => {
    const { strategyName, typedConfirmation } = req.body ?? {};
    if (typeof strategyName !== "string") {
      return res.status(400).json({ ok: false, error: "strategyName (string) is required" });
    }
    try {
      const portfolio = promote(db, strategyName, typedConfirmation, { log });
      res.json({ ok: true, portfolio });
    } catch (err) {
      // promote() throws with the precise failed gate — surface it verbatim.
      res.status(422).json({ ok: false, error: err.message });
    }
  });

  // --- Strategy Lab: advisory only — translates, validates, backtests on a
  // fixture and logs ONE recommendations row; never touches orders / fills /
  // positions / portfolios / live_orders, never calls promote(), never trades.
  app.post("/api/strategy/lab", async (req, res) => {
    try {
      res.json(await runStrategyLab(db, req.body ?? {}, { log }));
    } catch (err) {
      const status = err instanceof LabInputError ? 400 : err instanceof LabTranslationError ? 422 : 500;
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // --- Write path 2 of 2: kill switch ---
  app.post("/api/kill-switch", (req, res) => {
    const { engaged, reason } = req.body ?? {};
    if (typeof engaged !== "boolean") {
      return res.status(400).json({ ok: false, error: "engaged (boolean) is required" });
    }
    try {
      const state = setKillSwitch(db, engaged, reason ?? null, { log });
      res.json({ ok: true, killSwitch: state });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Built SPA (dashboard/web/dist) served from the same port.
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
  } else {
    log.warn?.(`[dashboard] ${WEB_DIST} not found — API only (run \`npm run build\` in dashboard/web)`);
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  };

  // Internal DB poll -> WS push on change. `ts` is excluded from the diff key
  // so an unchanged DB never triggers a push.
  let lastKey = null;
  let lastTradeId = maxTradeId(db);
  let lastState = readState(db);

  wss.on("connection", (ws) => {
    // First paint: full state immediately on connect (no client-side polling).
    ws.send(JSON.stringify({ type: "state", state: lastState }));
  });

  const poll = setInterval(() => {
    try {
      const state = readState(db);
      lastState = state;
      const key = JSON.stringify({ ...state, ts: 0 });
      if (key !== lastKey) {
        lastKey = key;
        broadcast({ type: "state", state });
      }
      const newTrades = tradesSince(db, lastTradeId);
      for (const trade of newTrades) {
        lastTradeId = Math.max(lastTradeId, trade.id);
        broadcast({ type: "trade", trade });
      }
    } catch (err) {
      log.warn?.(`[dashboard] poll error: ${err.message}`);
    }
  }, POLL_MS);

  const start = () =>
    new Promise((resolve) => {
      httpServer.listen(port, () => {
        log.info?.(`[dashboard] listening on http://localhost:${port} (WS at /ws) — db ${dbPath}`);
        resolve();
      });
    });

  const stop = () => {
    clearInterval(poll);
    for (const client of wss.clients) client.terminate();
    wss.close();
    httpServer.close();
    db.close();
  };

  return { app, httpServer, wss, start, stop };
}
