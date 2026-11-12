import assert from "node:assert/strict";
import { test } from "node:test";
import { fitDefault, parseDefault } from "../src/adapters/defaults.js";
import { identityStartFrom } from "../src/planner.js";

test("parseDefault understands what catalogs actually return", () => {
  assert.deepEqual(parseDefault("'new'::character varying"), { value: { kind: "literal", value: "new" } });
  assert.deepEqual(parseDefault("'it''s'"), { value: { kind: "literal", value: "it's" } });
  assert.deepEqual(parseDefault("(0)"), { value: { kind: "literal", value: 0 } });
  assert.deepEqual(parseDefault("0::bigint"), { value: { kind: "literal", value: 0 } });
  assert.deepEqual(parseDefault("-1.5"), { value: { kind: "literal", value: -1.5 } });
  assert.deepEqual(parseDefault("true"), { value: { kind: "literal", value: true } });
  assert.deepEqual(parseDefault("now()"), { value: { kind: "now" } });
  assert.deepEqual(parseDefault("CURRENT_TIMESTAMP(6)"), { value: { kind: "now" } });
  assert.deepEqual(parseDefault("SYSDATE"), { value: { kind: "now" } });
  assert.deepEqual(parseDefault("CURRENT_DATE"), { value: { kind: "today" } });
  assert.deepEqual(parseDefault("CURRENT_TIMESTAMP()"), { value: { kind: "now" } });
  assert.deepEqual(parseDefault(null), {});
  assert.deepEqual(parseDefault("NULL::text"), {});
});

test("parseDefault reports what it cannot carry instead of guessing", () => {
  assert.equal(parseDefault("nextval('seq'::regclass)").unsupported, "nextval('seq'::regclass)");
  assert.equal(parseDefault("uuid_generate_v4()").unsupported, "uuid_generate_v4()");
  assert.equal(parseDefault("(a + b)").unsupported, "(a + b)");
  assert.equal(parseDefault("99999999999999999999").unsupported, "99999999999999999999"); // beyond exact integer range
});

test("fitDefault only keeps defaults that make sense for the column", () => {
  assert.deepEqual(fitDefault({ kind: "literal", value: "0" }, "integer"), { kind: "literal", value: 0 });
  assert.deepEqual(fitDefault({ kind: "literal", value: "1" }, "boolean"), { kind: "literal", value: true });
  assert.deepEqual(fitDefault({ kind: "literal", value: 5 }, "string", 10), { kind: "literal", value: "5" });
  assert.equal(fitDefault({ kind: "literal", value: "toolongvalue" }, "string", 4), undefined);
  assert.equal(fitDefault({ kind: "literal", value: "abc" }, "integer"), undefined);
  assert.equal(fitDefault({ kind: "literal", value: "2020-01-01" }, "date"), undefined); // date literals differ per system
  assert.equal(fitDefault({ kind: "now" }, "string"), undefined);
  assert.deepEqual(fitDefault({ kind: "now" }, "timestamptz"), { kind: "now" });
  assert.deepEqual(fitDefault({ kind: "today" }, "date"), { kind: "today" });
  assert.equal(fitDefault({ kind: "today" }, "timestamp"), undefined);
});

test("identity continues after the highest existing value", () => {
  assert.equal(identityStartFrom(null), "1");
  assert.equal(identityStartFrom("41"), "42");
  assert.equal(identityStartFrom("9223372036854775806"), "9223372036854775807");
  assert.equal(identityStartFrom("7.0"), "8");
  assert.equal(identityStartFrom("-50"), "1");
  assert.throws(() => identityStartFrom("abc"), /Cannot continue/);
});
