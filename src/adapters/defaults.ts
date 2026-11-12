import type { DefaultValue } from "../types.js";

export interface ParsedDefault {
  value?: DefaultValue;
  /** The raw expression, when it exists but is not portable. */
  unsupported?: string;
}

const NOW = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?|sysdate|systimestamp|getdate\(\)|datetime\('now'\)|transaction_timestamp\(\))$/i;
const TODAY = /^(current_date(\(\))?|curdate\(\)|trunc\(sysdate\))$/i;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const QUOTED = /^'((?:[^']|'')*)'$/;

function stripParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Turn a source column default into something every target can express, or say it cannot be.
 * Handles the forms catalogs actually return: 'text'::character varying, (0), 'x', NOW(), CURRENT_TIMESTAMP(6), ...
 */
export function parseDefault(raw: string | null | undefined): ParsedDefault {
  if (raw === null || raw === undefined) return {};
  let t = stripParens(String(raw));
  if (t === "" || /^null(::.+)?$/i.test(t)) return {};
  // PostgreSQL appends casts: 'abc'::character varying, 5::bigint, 'x'::text
  const cast = /^(.*?)(::[A-Za-z_][\w\s."\[\]()]*)+$/.exec(t);
  if (cast && (QUOTED.test(cast[1]) || NUMBER.test(cast[1]))) t = cast[1];
  t = stripParens(t);

  const q = QUOTED.exec(t);
  if (q) return { value: { kind: "literal", value: q[1].replace(/''/g, "'") } };
  if (/^true$/i.test(t)) return { value: { kind: "literal", value: true } };
  if (/^false$/i.test(t)) return { value: { kind: "literal", value: false } };
  if (NUMBER.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && (Number.isSafeInteger(n) || /[.eE]/.test(t))) return { value: { kind: "literal", value: n } };
    return { unsupported: raw };
  }
  if (NOW.test(t)) return { value: { kind: "now" } };
  if (TODAY.test(t)) return { value: { kind: "today" } };
  return { unsupported: String(raw) };
}

/** Does a parsed default make sense for a column of this canonical type? Returns the (possibly converted) default. */
export function fitDefault(d: DefaultValue, type: string, length?: number): DefaultValue | undefined {
  switch (d.kind) {
    case "now":
      return type === "timestamp" || type === "timestamptz" ? d : undefined;
    case "today":
      return type === "date" ? d : undefined;
    case "literal": {
      const v = d.value;
      switch (type) {
        case "boolean":
          if (typeof v === "boolean") return d;
          if (v === 0 || v === 1) return { kind: "literal", value: v === 1 };
          if (typeof v === "string" && /^(true|false)$/i.test(v)) return { kind: "literal", value: v.toLowerCase() === "true" };
          if (typeof v === "string" && /^[01]$/.test(v)) return { kind: "literal", value: v === "1" };
          return undefined;
        case "integer":
        case "bigint":
          if (typeof v === "number" && Number.isInteger(v)) return d;
          if (typeof v === "string" && /^[+-]?\d+$/.test(v) && Number.isSafeInteger(Number(v))) return { kind: "literal", value: Number(v) };
          return undefined;
        case "decimal":
        case "float":
          if (typeof v === "number") return d;
          if (typeof v === "string" && NUMBER.test(v) && Number.isFinite(Number(v))) return { kind: "literal", value: Number(v) };
          return undefined;
        case "string":
        case "text":
          if (typeof v === "string") return length !== undefined && [...v].length > length ? undefined : d;
          if (typeof v === "number") return { kind: "literal", value: String(v) };
          return undefined;
        default:
          return undefined; // dates, json, binary, uuid: literal syntax differs per system, so report instead of guessing
      }
    }
  }
}
