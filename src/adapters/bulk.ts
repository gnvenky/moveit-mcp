import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ColumnInfo } from "../types.js";

/** One JSON object per line. Values are already in canonical form; `bind` turns them into strings the target can cast. */
export function ndjson(cols: ColumnInfo[], rows: unknown[][], bind: (v: unknown, c: ColumnInfo) => unknown): string {
  return rows
    .map((r) => {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        o[c.name] = r[i] === null || r[i] === undefined ? null : bind(r[i], c);
      });
      return JSON.stringify(o);
    })
    .join("\n");
}

/** Write text to a private temp file, run `fn` with its path, and always remove it. */
export async function withTempFile<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "moveit-bulk-"));
  const file = join(dir, `${randomUUID()}.json`);
  try {
    writeFileSync(file, text + "\n", { mode: 0o600 });
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Single-quoted SQL string for a file or stage path. */
export function sqlQuoted(s: string): string {
  if (/[\u0000\r\n]/.test(s)) throw new Error("Unsafe path");
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
