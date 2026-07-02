/**
 * QUANTFORGE Phase 3: global kill switch.
 *
 * Single-row `system_state` table (id = 1, created by openDb). While engaged:
 *   - PaperBroker.placeOrder REJECTs every new BUY order (entries only —
 *     resting orders and open positions are untouched by that check alone);
 *   - the worker's settlement sweep force-flattens EVERY open position
 *     across ALL portfolios, reason 'kill_switch', regardless of stop/target.
 *
 * Operated today via scripts/kill-switch.js (no dashboard until Phase 5);
 * the future dashboard button will call setKillSwitch() exactly the same way.
 */

export function getKillSwitch(db) {
  return db.prepare("SELECT * FROM system_state WHERE id = 1").get();
}

export function isKillSwitchEngaged(db) {
  return getKillSwitch(db).kill_switch_engaged === 1;
}

/**
 * Engage or disengage the kill switch. Every toggle is logged AND journaled
 * to `notifications` — this is a safety-critical operator action.
 */
export function setKillSwitch(db, engaged, reason = null, { log = console, now = Date.now() } = {}) {
  db.prepare("UPDATE system_state SET kill_switch_engaged = ?, engaged_at = ?, reason = ? WHERE id = 1").run(
    engaged ? 1 : 0,
    engaged ? now : null,
    engaged ? reason : null
  );
  const message = engaged
    ? `kill switch ENGAGED${reason ? `: ${reason}` : ""}`
    : "kill switch disengaged";
  db.prepare("INSERT INTO notifications (portfolio_id, ts, type, message) VALUES (NULL, ?, 'kill_switch', ?)").run(
    now,
    message
  );
  log.warn?.(`[kill-switch] ${message}`);
  return getKillSwitch(db);
}
