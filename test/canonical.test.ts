import assert from "node:assert/strict";
import { test } from "node:test";
import { TableDigest, coerce } from "../src/canonical.js";
import type { ColumnInfo } from "../src/types.js";

const col = (over: Partial<ColumnInfo>): ColumnInfo => ({ name: "c", nativeType: "x", type: "string", nullable: true, ...over });
const val = (v: unknown, c: Partial<ColumnInfo>) => {
  const r = coerce(v, col(c));
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.value;
};
const code = (v: unknown, c: Partial<ColumnInfo>) => {
  const r = coerce(v, col(c));
  assert.ok(!r.ok, "expected failure");
  return r.code;
};

test("integers respect their range", () => {
  assert.equal(val("2147483647", { type: "integer" }), 2147483647);
  assert.equal(code("2147483648", { type: "integer" }), "int_range");
  assert.equal(val(9007199254740993n, { type: "bigint" }), "9007199254740993"); // beyond 2^53 stays exact
  assert.equal(code(1.5, { type: "integer" }), "not_integer");
  assert.equal(code("9223372036854775808", { type: "bigint" }), "int_range");
});

test("decimals keep exact text and enforce precision and scale", () => {
  assert.equal(val("0.50", { type: "decimal" }), "0.5");
  assert.equal(val("1e3", { type: "decimal" }), "1000");
  assert.equal(val("-.25", { type: "decimal" }), "-0.25");
  assert.equal(val("12345678901234567890.123456789", { type: "decimal" }), "12345678901234567890.123456789");
  assert.equal(code("1.234", { type: "decimal", precision: 10, scale: 2 }), "scale_overflow");
  assert.equal(code("123456789", { type: "decimal", precision: 10, scale: 2 }), "precision_overflow");
  assert.equal(val("12345678.12", { type: "decimal", precision: 10, scale: 2 }), "12345678.12");
  assert.equal(code("abc", { type: "decimal" }), "not_decimal");
});

test("timestamps normalise to UTC and reject impossible dates", () => {
  assert.equal(val("2024-03-10 12:00:00+02:00", { type: "timestamptz" }), "2024-03-10 10:00:00.000000+00:00");
  assert.equal(val("2024-03-10T23:30:00-05:00", { type: "timestamptz" }), "2024-03-11 04:30:00.000000+00:00");
  assert.equal(val("2024-03-10 12:00:00.5", { type: "timestamp" }), "2024-03-10 12:00:00.500000");
  assert.equal(val(new Date("2024-01-02T03:04:05.678Z"), { type: "timestamp" }), "2024-01-02 03:04:05.678000");
  assert.equal(code("2024-02-30", { type: "date" }), "bad_date");
  assert.equal(code("not a date", { type: "timestamp" }), "bad_timestamp");
  assert.equal(val("2024-02-29", { type: "date" }), "2024-02-29");
});

test("booleans, uuids, json, binary", () => {
  assert.equal(val("YES", { type: "boolean" }), true);
  assert.equal(val(0n, { type: "boolean" }), false);
  assert.equal(code(2, { type: "boolean" }), "not_boolean");
  assert.equal(val("550E8400-E29B-41D4-A716-446655440000", { type: "uuid" }), "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(val('{"b":1,"a":[2,{"d":1,"c":0}]}', { type: "json" }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  assert.equal(code("{nope", { type: "json" }), "bad_json");
  assert.deepEqual(val("0xdeadbeef", { type: "binary" }), Buffer.from("deadbeef", "hex"));
  assert.equal(code("hello", { type: "binary" }), "bad_binary");
});

test("strings reject NUL and over-length values (counted in characters)", () => {
  assert.equal(code("a\u0000b", { type: "text" }), "nul_char");
  assert.equal(code("abcdef", { type: "string", length: 5 }), "too_long");
  assert.equal(val("日本語日本", { type: "string", length: 5 }), "日本語日本");
  assert.equal(coerce(null, col({ type: "integer" })).ok && (coerce(null, col({ type: "integer" })) as any).value, null);
});

test("digest is order independent and catches a single changed cell, naming the column", () => {
  const cols = [col({ name: "a", type: "integer" }), col({ name: "b", type: "string" }), col({ name: "c", type: "float" })];
  const rows = [
    [1, "x", 1.5],
    [2, "y", null],
    [3, "z", 0.1 + 0.2],
  ];
  const d1 = new TableDigest(cols);
  rows.forEach((r) => d1.add(r));
  const d2 = new TableDigest(cols);
  [...rows].reverse().forEach((r) => d2.add(r));
  assert.deepEqual(d1.result(), d2.result());

  const d3 = new TableDigest(cols);
  rows.forEach((r) => d3.add(r[0] === 2 ? [2, "Y", null] : r));
  assert.notEqual(d3.result().digest, d1.result().digest);
  const diff = Object.keys(d1.result().columns).filter((k) => d1.result().columns[k] !== d3.result().columns[k]);
  assert.deepEqual(diff, ["b"]);

  // NULL and empty string are different values
  const e1 = new TableDigest([col({ name: "s" })]);
  e1.add([null]);
  const e2 = new TableDigest([col({ name: "s" })]);
  e2.add([""]);
  assert.notEqual(e1.result().digest, e2.result().digest);

  // export/restore continues a digest exactly
  const half = new TableDigest(cols);
  half.add(rows[0]);
  const restored = TableDigest.restore(cols, half.export());
  restored.add(rows[1]);
  restored.add(rows[2]);
  assert.deepEqual(restored.result(), d1.result());
});
