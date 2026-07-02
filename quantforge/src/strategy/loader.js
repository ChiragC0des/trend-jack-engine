/**
 * QUANTFORGE strategy layer: loading (Phase 1).
 *
 * Loads strategy definition files (JSON or YAML) from disk — by convention
 * they live in /quantforge/strategies — and validates them against the
 * JSON Schema before handing them to the evaluator/backtester.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { assertValidStrategy } from "./validate.js";

/** Load and validate a single strategy file (.json, .yaml, or .yml). */
export async function loadStrategy(filePath) {
  const text = await readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  let strategy;
  if (ext === ".json") {
    strategy = JSON.parse(text);
  } else if (ext === ".yaml" || ext === ".yml") {
    strategy = YAML.parse(text);
  } else {
    throw new Error(`Unsupported strategy file extension: ${ext} (use .json, .yaml, or .yml)`);
  }
  return assertValidStrategy(strategy, path.basename(filePath));
}
