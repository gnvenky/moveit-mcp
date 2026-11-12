import { createHash } from "node:crypto";
import type { ColumnInfo } from "./types.js";

/**
 * Value coercion + canonical digesting.
 *
 * Every source value is coerced to a canonical wire form for the *target* column type.
 * The same normaliser is used to digest rows read back from the target, so a verified
 * migration means "what we sent is what the target holds", independent of driver quirks.
 *
 * Canonical forms:
 *   integer/bigint -> JS number when safe, else decimal string
 *   decimal        -> plain decimal string (no exponent)
 *   float          -> number
 *   boolean        -> true/false
 *   string/text    -> string
 *   date           -> 'YYYY-MM-DD'
 *   time           -> 'HH:MM:SS[.ffffff]'
 *   timestamp      -> 'YYYY-MM-DD HH:MM:SS.ffffff' (naive)
 *   timestamptz    -> 'YYYY-MM-DD HH:MM:SS.ffffff+00:00' (UTC)
 *   json           -> compact JSON string
 *   binary         -> Buffer
 *   uuid           -> lowercase string
 */

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; reason: string };

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

const fail = (code: string, reason: string): CoerceResult => ({ ok: false, code, reason });
const good = (value: unknown): CoerceResult => ({ ok: true, value });

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function fmtDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function fmtTime(d: Date, micros = 6): string {
  const frac = String(d.getUTCMilliseconds()).padStart(3, "0").padEnd(micros, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${frac}`;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

interface ParsedTs {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  frac: string; // up to 6 digits, right-padded
  offsetMinutes: number | null; // null => no zone in the text
  hasTime: boolean;
}

function parseIso(s: string): ParsedTs | null {
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, tz] = m;
  let offsetMinutes: number | null = null;
  if (tz) {
    if (tz.toUpperCase() === "Z") offsetMinutes = 0;
    else {
      const sign = tz[0] === "-" ? -1 : 1;
      const digits = tz.slice(1).replace(":", "");
      const hh = Number(digits.slice(0, 2));
      const mm = Number(digits.slice(2, 4) || "0");
      offsetMinutes = sign * (hh * 60 + mm);
    }
  }
  const p: ParsedTs = {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    h: Number(h ?? 0),
    mi: Number(mi ?? 0),
    s: Number(sec ?? 0),
    frac: (frac ?? "").slice(0, 6).padEnd(6, "0"),
    offsetMinutes,
    hasTime: h !== undefined,
  };
  // calendar validity
  const probe = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s));
  if (
    probe.getUTCFullYear() !== p.y ||
    probe.getUTCMonth() !== p.mo - 1 ||
    probe.getUTCDate() !== p.d ||
    p.h > 23 ||
    p.mi > 59 ||
    p.s > 59
  )
    return null;
  return p;
}

function fmtParsed(p: ParsedTs, withZone: boolean): string {
  let { y, mo, d, h, mi, s } = p;
  if (p.offsetMinutes !== null && p.offsetMinutes !== 0) {
    // shift to UTC
    const t = Date.UTC(y, mo - 1, d, h, mi, s) - p.offsetMinutes * 60_000;
    const u = new Date(t);
    y = u.getUTCFullYear();
    mo = u.getUTCMonth() + 1;
    d = u.getUTCDate();
    h = u.getUTCHours();
    mi = u.getUTCMinutes();
    s = u.getUTCSeconds();
  }
  const base = `${pad(y, 4)}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}.${p.frac}`;
  return withZone ? `${base}+00:00` : base;
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^[+-]?\d+$/.test(t)) return BigInt(t);
    if (/^[+-]?\d+\.0+$/.test(t)) return BigInt(t.split(".")[0]);
    return null;
  }
  return null;
}

/** Normalise a numeric (number|string|bigint) to a plain decimal string without exponent. */
function toDecimalString(v: unknown): string | null {
  if (typeof v === "bigint") return v.toString();
  let t: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    t = String(v);
  } else if (typeof v === "string") {
    t = v.trim();
  } else return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const sign = m[1] === "-" ? "-" : "";
  let int = m[2] || "0";
  let frac = m[3] ?? "";
  if (m[4]) {
    const exp = Number(m[4]);
    if (exp > 0) {
      const moved = frac.padEnd(exp, "0");
      int += moved.slice(0, exp);
      frac = moved.slice(exp);
    } else if (exp < 0) {
      const all = int.padStart(-exp + 1, "0");
      frac = all.slice(all.length + exp) + frac;
      int = all.slice(0, all.length + exp) || "0";
    }
  }
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  const out = frac ? `${int}.${frac}` : int;
  return out === "0" ? "0" : sign + out;
}

const TRUE_SET = new Set(["true", "t", "yes", "y", "1", "on"]);
const FALSE_SET = new Set(["false", "f", "no", "n", "0", "off"]);

export function coerce(value: unknown, target: ColumnInfo): CoerceResult {
  if (value === null || value === undefined) return good(null);

  switch (target.type) {
    case "integer":
    case "bigint": {
      const b = toBigInt(value);
      if (b === null) return fail("not_integer", `value is not an integer (${typeName(value)})`);
      const [lo, hi] = target.type === "integer" ? [INT32_MIN, INT32_MAX] : [INT64_MIN, INT64_MAX];
      if (b < lo || b > hi) return fail("int_range", `integer out of ${target.type} range`);
      const n = Number(b);
      return good(Number.isSafeInteger(n) ? n : b.toString());
    }
    case "decimal": {
      const s = toDecimalString(value);
      if (s === null) return fail("not_decimal", `value is not a number (${typeName(value)})`);
      if (target.precision !== undefined) {
        const scale = target.scale ?? 0;
        const [i, f = ""] = s.replace("-", "").split(".");
        const intDigits = i === "0" ? 0 : i.length;
        if (f.length > scale)
          return fail("scale_overflow", `has ${f.length} decimal places, target allows ${scale}`);
        if (intDigits > target.precision - scale)
          return fail(
            "precision_overflow",
            `has ${intDigits} integer digits, target DECIMAL(${target.precision},${scale}) allows ${target.precision - scale}`,
          );
      }
      return good(s);
    }
    case "float": {
      const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(String(value).trim());
      if (typeof value === "boolean" || String(value).trim() === "" || !Number.isFinite(n))
        return fail("not_float", "value is not a finite number");
      return good(n);
    }
    case "boolean": {
      if (typeof value === "boolean") return good(value);
      if (typeof value === "number" || typeof value === "bigint") {
        if (value === 1 || value === 1n) return good(true);
        if (value === 0 || value === 0n) return good(false);
        return fail("not_boolean", "number is not 0 or 1");
      }
      if (typeof value === "string") {
        const t = value.trim().toLowerCase();
        if (TRUE_SET.has(t)) return good(true);
        if (FALSE_SET.has(t)) return good(false);
      }
      return fail("not_boolean", "value is not a recognisable boolean");
    }
    case "string":
    case "text":
    case "unknown": {
      let s: string;
      if (typeof value === "string") s = value;
      else if (value instanceof Date) s = value.toISOString();
      else if (Buffer.isBuffer(value) || value instanceof Uint8Array)
        return fail("binary_to_text", "binary value cannot be stored as text without an explicit encoding");
      else if (typeof value === "object") s = JSON.stringify(value);
      else s = String(value);
      if (s.includes("\u0000")) return fail("nul_char", "contains a NUL (\\u0000) character");
      if (target.type === "string" && target.length !== undefined && [...s].length > target.length)
        return fail("too_long", `length ${[...s].length} exceeds target limit ${target.length}`);
      return good(s);
    }
    case "date": {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? fail("bad_date", "invalid Date") : good(fmtDate(value));
      if (typeof value === "string") {
        const p = parseIso(value);
        if (!p) return fail("bad_date", "not an ISO-8601 date (YYYY-MM-DD)");
        return good(`${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`);
      }
      return fail("bad_date", `cannot read ${typeName(value)} as a date`);
    }
    case "time": {
      if (value instanceof Date) return good(fmtTime(value));
      if (typeof value === "string") {
        const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(value.trim());
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59)
          return fail("bad_time", "not an HH:MM[:SS[.ffffff]] time");
        return good(`${m[1]}:${m[2]}:${m[3] ?? "00"}.${(m[4] ?? "").slice(0, 6).padEnd(6, "0")}`);
      }
      return fail("bad_time", `cannot read ${typeName(value)} as a time`);
    }
    case "timestamp":
    case "timestamptz": {
      const withZone = target.type === "timestamptz";
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return fail("bad_timestamp", "invalid Date");
        return good(`${fmtDate(value)} ${fmtTime(value)}${withZone ? "+00:00" : ""}`);
      }
      if (typeof value === "string") {
        const p = parseIso(value);
        if (!p) return fail("bad_timestamp", "not an ISO-8601 timestamp");
        return good(fmtParsed(p, withZone));
      }
      return fail("bad_timestamp", `cannot read ${typeName(value)} as a timestamp`);
    }
    case "json": {
      if (typeof value === "string") {
        try {
          return good(stableStringify(JSON.parse(value)));
        } catch {
          return fail("bad_json", "string is not valid JSON");
        }
      }
      if (Buffer.isBuffer(value)) return fail("bad_json", "binary is not JSON");
      try {
        return good(stableStringify(value));
      } catch {
        return fail("bad_json", "value is not JSON-serialisable");
      }
    }
    case "binary": {
      if (Buffer.isBuffer(value)) return good(value);
      if (value instanceof Uint8Array) return good(Buffer.from(value));
      if (typeof value === "string") {
        const m = /^(?:0x|\\x)([0-9a-fA-F]*)$/.exec(value.trim());
        if (m && m[1].length % 2 === 0) return good(Buffer.from(m[1], "hex"));
      }
      return fail("bad_binary", "expected bytes or a 0x-prefixed hex string");
    }
    case "uuid": {
      const s = String(value).trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))
        return fail("bad_uuid", "not a UUID");
      return good(s);
    }
  }
}

/** JSON with object keys sorted, so key order never causes false mismatches (jsonb and VARIANT reorder keys). */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as any)[k]);
    return o;
  }
  return v;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (v instanceof Date) return "Date";
  if (Buffer.isBuffer(v)) return "binary";
  return typeof v;
}

// ---------------------------------------------------------------- digests

/** String used for hashing. Floats are compared at 15 significant digits. */
export function digestForm(value: unknown, type: ColumnInfo["type"]): string {
  if (value === null || value === undefined) return "\u0000N";
  if (Buffer.isBuffer(value)) return "b:" + value.toString("hex");
  if (type === "float" && typeof value === "number") return "f:" + Number(value.toPrecision(15));
  if (typeof value === "boolean") return value ? "t" : "f";
  return "v:" + String(value);
}

const MASK64 = (1n << 64n) - 1n;

function h64(s: string): bigint {
  return createHash("sha256").update(s).digest().readBigUInt64BE(0);
}

/**
 * Order-independent digest of a row set: a sum of per-row hashes mod 2^64, plus the same
 * per-column. When the overall digest differs, per-column digests say which columns differ.
 */
export class TableDigest {
  rows = 0;
  private total = 0n;
  private cols: bigint[];
  constructor(private readonly columns: ColumnInfo[]) {
    this.cols = columns.map(() => 0n);
  }
  /** `values` must already be in canonical (coerced) form, aligned to columns. */
  add(values: unknown[]): void {
    const parts = values.map((v, i) => digestForm(v, this.columns[i].type));
    this.total = (this.total + h64(parts.join("\u001f"))) & MASK64;
    for (let i = 0; i < parts.length; i++)
      this.cols[i] = (this.cols[i] + h64(`${i}\u001e${parts[i]}`)) & MASK64;
    this.rows++;
  }
  export(): { rows: number; total: string; cols: string[] } {
    return { rows: this.rows, total: this.total.toString(16), cols: this.cols.map((c) => c.toString(16)) };
  }
  static restore(columns: ColumnInfo[], s: { rows: number; total: string; cols: string[] }): TableDigest {
    const d = new TableDigest(columns);
    d.rows = s.rows;
    d.total = BigInt("0x" + s.total);
    d.cols = s.cols.map((c) => BigInt("0x" + c));
    return d;
  }
  result(): DigestResult {
    return {
      rows: this.rows,
      digest: this.total.toString(16).padStart(16, "0"),
      columns: Object.fromEntries(
        this.columns.map((c, i) => [c.name, this.cols[i].toString(16).padStart(16, "0")]),
      ),
    };
  }
}

export interface DigestResult {
  rows: number;
  digest: string;
  columns: Record<string, string>;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
