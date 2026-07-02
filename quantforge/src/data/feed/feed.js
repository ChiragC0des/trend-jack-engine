/**
 * Base class for live price feeds — see ./index.js for the full contract.
 * Kept in its own module so implementations can extend it without a
 * circular import through the barrel file.
 */

import { EventEmitter } from "node:events";

export class Feed extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = [];
  }

  subscribe(symbol, timeframe) {
    if (!this.subscriptions.some((s) => s.symbol === symbol && s.timeframe === timeframe)) {
      this.subscriptions.push({ symbol, timeframe });
    }
    return this;
  }

  async start() {
    throw new Error("Feed.start() must be implemented by a subclass");
  }

  async stop() {}
}
