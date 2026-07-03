/**
 * QUANTFORGE Phase 4: plain-markdown memory (no vector DB, per spec).
 *
 * /quantforge/memory holds a handful of human-editable .md files. Every AI
 * call injects readMemory()'s concatenated text into its prompt; calls that
 * reach significant conclusions (analyst diagnosis, daily brief) append a
 * dated entry back via appendMemory(). Memory files are one of only three
 * things the AI layer may write (Invariant #2 — see src/ai/providers/index.js).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MEMORY_DIR = path.join(ROOT, "memory");

/** All memory .md files concatenated with filename headers, for prompts. */
export function readMemory(dir = MEMORY_DIR) {
  if (!fs.existsSync(dir)) return "(no memory files)";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) return "(no memory files)";
  return files
    .map((f) => `## memory/${f}\n\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}`)
    .join("\n\n");
}

/**
 * Append a dated entry to one memory file. `filename` must be a bare .md
 * basename — no path separators — so a malformed (or model-derived) name can
 * never write outside the memory directory.
 */
export function appendMemory(filename, text, { dir = MEMORY_DIR, now = Date.now() } = {}) {
  if (path.basename(filename) !== filename || !filename.endsWith(".md")) {
    throw new Error(`appendMemory: invalid memory filename ${JSON.stringify(filename)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  const entry = `\n### ${new Date(now).toISOString().slice(0, 10)}\n\n${text.trim()}\n`;
  fs.appendFileSync(file, entry, "utf8");
  return file;
}
