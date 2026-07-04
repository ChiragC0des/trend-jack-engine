/**
 * QUANTFORGE dashboard server entry point (Phase 5).
 *
 * Run with: npm run dashboard    (or: node dashboard/server/index.js)
 *
 * Configuration via environment:
 *   QF_DB_PATH         database file (default var/quantforge.db)
 *   QF_DASHBOARD_PORT  HTTP/WS port (default 4100)
 */

import { DEFAULT_DB_PATH } from "../../src/db/index.js";
import { createDashboardServer, DEFAULT_DASHBOARD_PORT } from "./server.js";

const server = createDashboardServer({
  dbPath: process.env.QF_DB_PATH ?? DEFAULT_DB_PATH,
  port: process.env.QF_DASHBOARD_PORT != null ? Number(process.env.QF_DASHBOARD_PORT) : DEFAULT_DASHBOARD_PORT,
});
await server.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[dashboard] ${signal} received — shutting down`);
    server.stop();
    process.exit(0);
  });
}
