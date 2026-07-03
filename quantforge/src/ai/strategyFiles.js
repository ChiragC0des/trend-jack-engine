/**
 * QUANTFORGE Phase 4: the single write path for AI-generated strategy files.
 *
 * Both the translator and the analyst funnel through writeNewStrategyFile,
 * which (a) re-validates against the real schema and (b) creates files with
 * the O_EXCL "wx" flag — the filesystem itself guarantees an existing file
 * (ema-cross-basic.json, engulfing-breakout.json, or any prior AI output)
 * can never be overwritten; on collision the name gets a numeric suffix.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidStrategy } from "../strategy/validate.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STRATEGIES_DIR = path.join(ROOT, "strategies");

/** Filesystem-safe base name from a strategy name ("My Strat!" -> "my-strat"). */
export function slugifyStrategyName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`cannot derive a filename from strategy name ${JSON.stringify(name)}`);
  return slug;
}

/**
 * Validate and write `strategy` to a NEW .json file under `dir`.
 * @returns {string} the absolute path actually written
 */
export function writeNewStrategyFile(strategy, { dir = STRATEGIES_DIR, baseName } = {}) {
  assertValidStrategy(strategy, `generated strategy "${strategy?.name}"`);
  fs.mkdirSync(dir, { recursive: true });
  const base = baseName ?? slugifyStrategyName(strategy.name);
  const json = JSON.stringify(strategy, null, 2) + "\n";
  for (let i = 0; i < 1000; i++) {
    const file = path.join(dir, (i === 0 ? base : `${base}-${i + 1}`) + ".json");
    try {
      fs.writeFileSync(file, json, { flag: "wx" }); // wx: fail if the path exists
      return file;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not find a free filename for "${base}" after 1000 attempts`);
}
