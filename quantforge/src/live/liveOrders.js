/**
 * QUANTFORGE Phase 6: shared live-order journal helpers.
 *
 * Both brokers and the executor write `live_orders` through recordLiveOrder,
 * so the idempotency rail lives in exactly one place:
 *
 *   - makeClientOrderId derives a DETERMINISTIC id from the order intent
 *     (portfolio, symbol, side, qty) plus a coarse time bucket (default
 *     1 minute). A crashed-and-retried submission inside the same bucket
 *     re-derives the SAME id, hits the UNIQUE constraint / duplicate gate,
 *     and can never double-send. Kept under Binance's 36-char client-id cap.
 *
 *   - recordLiveOrder inserts the row; only ONE row per client_order_id can
 *     ever hold a non-REJECTED status. When a REJECTION collides with an
 *     already-journaled id (e.g. the duplicate gate refusing a retry of an
 *     already-placed intent), the rejection is journaled under a derived
 *     '<id>~rN' suffix — the refusal is still auditable without weakening
 *     the UNIQUE rail that protects the canonical id.
 */

import { createHash } from "node:crypto";

export const CLIENT_ID_BUCKET_MS = 60_000;

export function makeClientOrderId({ portfolioId, symbol, side, qty, ts = Date.now(), bucketMs = CLIENT_ID_BUCKET_MS }) {
  const bucket = Math.floor(ts / bucketMs);
  const hash = createHash("sha256")
    .update(`${portfolioId}|${symbol}|${side}|${qty}|${bucket}`)
    .digest("hex")
    .slice(0, 10);
  const sym = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return `qf-${portfolioId}-${sym}-${side === "BUY" ? "b" : "s"}-${hash}`;
}

/**
 * Insert one live_orders row + its notifications entry. Returns the stored
 * row. Never throws on a client_order_id collision for REJECTED rows (see
 * header); a collision on a NON-rejected status is a real bug upstream (the
 * duplicate gate should have refused first) and is allowed to throw.
 */
export function recordLiveOrder(db, { portfolioId, clientOrderId, symbol, side, qty, price, notional, mode, status, gate, reason }, { log = console, now = Date.now() } = {}) {
  const insert = db.prepare(
    `INSERT INTO live_orders (portfolio_id, client_order_id, symbol, side, qty, price, notional, mode, status, gate, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let storedId = clientOrderId;
  let info;
  try {
    info = insert.run(portfolioId, storedId, symbol, side, qty, price, notional, mode, status, gate, reason, now);
  } catch (err) {
    if (status !== "REJECTED" || !/UNIQUE/.test(String(err))) throw err;
    for (let n = 1; ; n++) {
      storedId = `${clientOrderId}~r${n}`;
      try {
        info = insert.run(portfolioId, storedId, symbol, side, qty, price, notional, mode, status, gate, reason, now);
        break;
      } catch (retryErr) {
        if (!/UNIQUE/.test(String(retryErr))) throw retryErr;
      }
    }
  }
  const type = status === "REJECTED" ? "live_rejected" : mode === "testnet" ? "live_testnet" : "live_dry_run";
  db.prepare("INSERT INTO notifications (portfolio_id, ts, type, message) VALUES (?, ?, ?, ?)").run(
    portfolioId,
    now,
    type,
    `[${mode}] ${status} ${side} ${qty} ${symbol}${gate ? ` (gate: ${gate})` : ""}${reason ? ` — ${reason}` : ""}`
  );
  return db.prepare("SELECT * FROM live_orders WHERE id = ?").get(info.lastInsertRowid);
}
