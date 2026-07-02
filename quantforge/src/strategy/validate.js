/**
 * Strategy schema validation (Phase 1).
 * Validates parsed strategy objects against schema/strategy.schema.json
 * (JSON Schema draft 2020-12) using ajv.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schema",
  "strategy.schema.json"
);

const AjvClass = Ajv2020.default ?? Ajv2020;
const ajv = new AjvClass({ allErrors: true, strict: false });
export const strategySchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const compiled = ajv.compile(strategySchema);

/**
 * Validate a strategy object. Returns { valid, errors } where errors is a
 * list of human-readable strings (empty when valid).
 */
export function validateStrategy(strategy) {
  const valid = compiled(strategy);
  const errors = valid
    ? []
    : compiled.errors.map((e) => `${e.instancePath || "(root)"} ${e.message}`);
  return { valid, errors };
}

/** Validate and throw a descriptive error when invalid. */
export function assertValidStrategy(strategy, label = "strategy") {
  const { valid, errors } = validateStrategy(strategy);
  if (!valid) {
    throw new Error(`Invalid ${label}:\n  - ${errors.join("\n  - ")}`);
  }
  return strategy;
}
