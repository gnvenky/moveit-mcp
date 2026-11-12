import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex, stableStringify } from "./canonical.js";

export interface EvidenceEntry {
  seq: number;
  ts: string;
  type: string;
  data: unknown;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/**
 * Append-only, hash-chained log. Each entry commits to the one before it, so editing or
 * deleting any line breaks verification. This is tamper-evident, not tamper-proof: anyone who
 * can rewrite the whole file can rebuild the chain. Anchor the final hash somewhere else if that matters.
 */
export class EvidenceLog {
  private seq = 0;
  private prev = GENESIS;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const entries = readEntries(file);
      if (entries.length) {
        this.seq = entries[entries.length - 1].seq;
        this.prev = entries[entries.length - 1].hash;
      }
    }
  }

  append(type: string, data: unknown): EvidenceEntry {
    const entry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      type,
      data,
      prev: this.prev,
    };
    const hash = sha256Hex(this.prev + stableStringify({ seq: entry.seq, ts: entry.ts, type, data }));
    const full: EvidenceEntry = { ...entry, hash };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    this.prev = hash;
    return full;
  }

  get head(): string {
    return this.prev;
  }
}

function readEntries(file: string): EvidenceEntry[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvidenceEntry);
}

export function verifyEvidence(file: string): { ok: boolean; entries: number; head: string; brokenAt?: number } {
  if (!existsSync(file)) return { ok: false, entries: 0, head: GENESIS, brokenAt: 0 };
  let prev = GENESIS;
  let n = 0;
  for (const e of readEntries(file)) {
    const expect = sha256Hex(prev + stableStringify({ seq: e.seq, ts: e.ts, type: e.type, data: e.data }));
    if (e.prev !== prev || e.hash !== expect || e.seq !== n + 1) return { ok: false, entries: n, head: prev, brokenAt: e.seq };
    prev = e.hash;
    n++;
  }
  return { ok: true, entries: n, head: prev };
}

export function readEvidence(file: string): EvidenceEntry[] {
  return existsSync(file) ? readEntries(file) : [];
}
