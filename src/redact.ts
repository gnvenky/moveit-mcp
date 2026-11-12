/** Redaction for anything shown to an agent: sample rows, profiles, failure examples. On by default. */
const PII_COLUMN =
  /(pass(word)?|pwd|secret|token|api[_-]?key|ssn|social[_-]?sec|tax[_-]?id|card|cvv|iban|routing|account[_-]?(no|num)|e[-_]?mail|phone|mobile|\bdob\b|birth|first[_-]?name|last[_-]?name|full[_-]?name|surname|street|address|postal|zip|ip[_-]?addr)/i;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_DIGITS = /\b\d{13,19}\b/g;

export function isSensitiveColumn(name: string): boolean {
  return PII_COLUMN.test(name);
}

export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<binary ${v.length} bytes>`;
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function redactValue(column: string, v: unknown, enabled = true): unknown {
  const safe = jsonSafe(v);
  if (!enabled || safe === null || safe === undefined) return safe;
  if (isSensitiveColumn(column)) return "[redacted]";
  if (typeof safe === "string") {
    const s = safe.replace(EMAIL, "$1***@$2***$3").replace(SSN, "***-**-****").replace(LONG_DIGITS, "****");
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  }
  if (typeof safe === "object") return redactValue(column, JSON.stringify(safe), enabled);
  return safe;
}
