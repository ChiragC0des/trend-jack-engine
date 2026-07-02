/**
 * QUANTFORGE data layer: fixture replay feed (Phase 2).
 *
 * Replays a local candle fixture as a sequence of live-like candle-close
 * events at an accelerated, configurable interval — fully offline, so demos
 * and tests exercise the exact same engine code path as a real feed. Every
 * subscription receives the same fixture candles tagged with its own
 * (symbol, timeframe); emits "end" after the last candle.
 */

import { loadFixture } from "../candleLoader.js";
import { Feed } from "./feed.js";

export class FixtureReplayFeed extends Feed {
  /**
   * @param {object} options { fixturePath, intervalMs = 50 }
   */
  constructor({ fixturePath, intervalMs = 50 } = {}) {
    super();
    if (!fixturePath) throw new Error("FixtureReplayFeed requires a fixturePath");
    this.fixturePath = fixturePath;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  async start() {
    if (this.subscriptions.length === 0) throw new Error("No subscriptions — call subscribe() before start()");
    const candles = await loadFixture(this.fixturePath);
    let i = 0;
    this.timer = setInterval(() => {
      if (i >= candles.length) {
        this.stopTimer();
        this.emit("end");
        return;
      }
      const candle = candles[i++];
      for (const { symbol, timeframe } of this.subscriptions) {
        this.emit("candle", { symbol, timeframe, candle });
      }
    }, this.intervalMs);
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async stop() {
    this.stopTimer();
  }
}
