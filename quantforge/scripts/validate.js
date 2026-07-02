/**
 * Validates every strategy file in /strategies against
 * schema/strategy.schema.json (JSON Schema draft 2020-12, via ajv).
 * Run with: npm run validate
 * Exits non-zero if any strategy is invalid.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import { validateStrategy } from "../src/strategy/validate.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRATEGIES_DIR = path.join(ROOT, "strategies");

const files = (await readdir(STRATEGIES_DIR)).filter((f) => /\.(json|ya?ml)$/i.test(f));
if (files.length === 0) {
  console.error("No strategy files found in /strategies");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const text = await readFile(path.join(STRATEGIES_DIR, file), "utf8");
  const strategy = /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
  const { valid, errors } = validateStrategy(strategy);
  if (valid) {
    console.log(`PASS  ${file}  (${strategy.name})`);
  } else {
    failed++;
    console.error(`FAIL  ${file}`);
    for (const e of errors) console.error(`      - ${e}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} strategy files valid.`);
process.exit(failed ? 1 : 0);
