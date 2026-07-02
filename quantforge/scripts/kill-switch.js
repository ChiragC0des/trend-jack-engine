/**
 * QUANTFORGE Phase 3: global kill switch CLI.
 *
 *   node scripts/kill-switch.js on ["reason"]   engage (blocks new BUYs;
 *                                               worker flattens all positions)
 *   node scripts/kill-switch.js off             disengage
 *   node scripts/kill-switch.js status          show current state
 *
 * QF_DB_PATH selects the database (default var/quantforge.db). There is no
 * dashboard until Phase 5 — this CLI is how the switch is operated for now;
 * the future dashboard button calls the same setKillSwitch() function.
 */

import { openDb, DEFAULT_DB_PATH } from "../src/db/index.js";
import { setKillSwitch, getKillSwitch } from "../src/confidence/killSwitch.js";

const [command, ...rest] = process.argv.slice(2);
const db = openDb(process.env.QF_DB_PATH ?? DEFAULT_DB_PATH);

function printStatus(state) {
  if (state.kill_switch_engaged) {
    console.log(`kill switch: ENGAGED since ${new Date(state.engaged_at).toISOString()}${state.reason ? ` — reason: ${state.reason}` : ""}`);
  } else {
    console.log("kill switch: disengaged");
  }
}

switch (command) {
  case "on":
    printStatus(setKillSwitch(db, true, rest.join(" ") || "engaged via CLI"));
    break;
  case "off":
    printStatus(setKillSwitch(db, false));
    break;
  case "status":
    printStatus(getKillSwitch(db));
    break;
  default:
    console.error("usage: node scripts/kill-switch.js on [\"reason\"] | off | status");
    process.exitCode = 1;
}
db.close();
