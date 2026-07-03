/**
 * QUANTFORGE Phase 4: the recommendation ledger.
 *
 * Every AI output lands here as one row: what was said (body), what kind of
 * thing it was (analysis | operation | note), and which provider/model said
 * it. Kept SEPARATE from trades/fills by design — this is a log of what the
 * AI *said*, not what was *executed*, so call quality can later be scored
 * independently of execution quality. This table is the only trading-DB
 * table the AI layer writes (Invariant #2 — see src/ai/providers/index.js).
 */

export function logRecommendation(
  db,
  { portfolioId = null, strategyName = null, type, title, body, provider = null, model = null, now = Date.now() }
) {
  const info = db
    .prepare(
      `INSERT INTO recommendations (portfolio_id, strategy_name, type, title, body, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(portfolioId, strategyName, type, title, body, provider, model, now);
  return Number(info.lastInsertRowid);
}

export function listRecommendations(db) {
  return db.prepare("SELECT * FROM recommendations ORDER BY id").all();
}
