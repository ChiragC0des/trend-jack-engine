/**
 * QUANTFORGE data layer: Binance live feed (Phase 2).
 *
 * Connects to Binance's public, keyless kline WebSocket stream and emits a
 * normalized candle event whenever a kline CLOSES (kline payloads carry an
 * `x` flag marking closure; in-progress updates are ignored). Uses the
 * WebSocket global built into Node >= 21 — no extra dependency.
 *
 * Resilience contract: connection failures NEVER crash the process — they
 * log a warning, emit a non-fatal "error" event, and retry with capped
 * exponential backoff until stop() is called.
 */

import { normalizeCandle } from "../candleLoader.js";
import { Feed } from "./feed.js";

const BASE_URL = "wss://stream.binance.com:9443/stream";

/** "BTC/USDT" -> "btcusdt" (Binance stream naming). */
function streamSymbol(symbol) {
  return symbol.replace("/", "").toLowerCase();
}

export class BinanceFeed extends Feed {
  /**
   * @param {object} options { log = console, maxBackoffMs = 60000 }
   */
  constructor({ log = console, maxBackoffMs = 60_000 } = {}) {
    super();
    this.log = log;
    this.maxBackoffMs = maxBackoffMs;
    this.ws = null;
    this.stopped = false;
    this.backoffMs = 1000;
    this.reconnectTimer = null;
  }

  async start() {
    if (this.subscriptions.length === 0) throw new Error("No subscriptions — call subscribe() before start()");
    if (typeof WebSocket !== "function") {
      this.warn("global WebSocket unavailable (Node >= 21 required) — BinanceFeed disabled");
      return;
    }
    this.stopped = false;
    this.connect();
  }

  connect() {
    const streams = this.subscriptions
      .map(({ symbol, timeframe }) => `${streamSymbol(symbol)}@kline_${timeframe}`)
      .join("/");
    const url = `${BASE_URL}?streams=${streams}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.warn(`connection failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.log.info?.(`[binance-feed] connected: ${streams}`);
    };
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onerror = (event) => {
      this.warn(`socket error: ${event?.message ?? "unknown"}`);
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const k = msg?.data?.k;
    if (!k || !k.x) return; // only closed klines
    const candle = normalizeCandle({
      timestamp: k.t,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
    });
    const sub = this.subscriptions.find(
      (s) => streamSymbol(s.symbol) === k.s.toLowerCase() && s.timeframe === k.i
    );
    if (sub) this.emit("candle", { symbol: sub.symbol, timeframe: sub.timeframe, candle });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.warn(`reconnecting in ${this.backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      if (!this.stopped) this.connect();
    }, this.backoffMs);
  }

  warn(message) {
    this.log.warn(`[binance-feed] ${message}`);
    // Node throws on unhandled "error" events — only emit if someone listens.
    if (this.listenerCount("error") > 0) this.emit("error", new Error(message));
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed/failed — nothing to do
      }
      this.ws = null;
    }
  }
}
