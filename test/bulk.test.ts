import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ndjson, sqlQuoted, withTempFile } from "../src/adapters/bulk.js";
import { DatabricksAdapter } from "../src/adapters/databricks.js";
import { SnowflakeAdapter } from "../src/adapters/snowflake.js";
import type { ColumnInfo, TableInfo } from "../src/types.js";

const col = (name: string, type: ColumnInfo["type"], o: Partial<ColumnInfo> = {}): ColumnInfo => ({ name, nativeType: type, type, nullable: true, ...o });
const table: TableInfo = {
  name: "T",
  primaryKey: ["id"],
  columns: [
    col("id", "bigint"),
    col("amount", "decimal", { precision: 12, scale: 2 }),
    col("name", "string"),
    col("ok", "boolean"),
    col("born", "date"),
    col("seen", "timestamptz"),
    col("doc", "json"),
    col("raw", "binary"),
  ],
};
const names = table.columns.map((c) => c.name);
const rows = [
  [1, "12.50", "caf\u00e9 \"quoted\" \n newline", true, "2026-01-02", "2026-01-02 03:04:05.000000+00:00", '{"a":1}', Buffer.from([0, 255, 16])],
  [2, null, null, false, null, null, null, null],
];

test("ndjson: one object per line, nulls kept, strings escaped", () => {
  const text = ndjson(table.columns, rows, (v) => (Buffer.isBuffer(v) ? v.toString("hex") : v));
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).raw, "00ff10");
  assert.equal(JSON.parse(lines[0]).name, 'caf\u00e9 "quoted" \n newline');
  assert.equal(JSON.parse(lines[1]).amount, null);
});

test("withTempFile removes the file even when the work fails", async () => {
  let path = "";
  await assert.rejects(
    withTempFile("x", async (p) => {
      path = p;
      assert.ok(existsSync(p));
      throw new Error("fail");
    }),
    /fail/,
  );
  assert.equal(existsSync(path), false);
});

test("sqlQuoted escapes quotes and backslashes and refuses newlines", () => {
  assert.equal(sqlQuoted("it's"), "'it\\'s'");
  assert.equal(sqlQuoted("C:\\tmp"), "'C:\\\\tmp'");
  assert.throws(() => sqlQuoted("a\nb"), /Unsafe/);
});

test("snowflake bulk load: PUT, COPY INTO with typed casts, row count check, REMOVE", async () => {
  const a = new SnowflakeAdapter({ type: "snowflake", bulkLoad: true });
  assert.equal(a.preferredBatchSize, 50000);
  const log: string[] = [];
  let staged = "";
  (a as any).exec = async (sql: string) => {
    log.push(sql);
    const m = /^PUT 'file:\/\/(.+?)' @~/.exec(sql);
    if (m) staged = readFileSync(m[1].replace(/\\\\/g, "\\"), "utf8"); // the file exists only for the duration of the call
  };
  (a as any).query = async (sql: string) => {
    log.push(sql);
    return [["f.json.gz", "LOADED", 2, 2, 1, 0, null, null, null, null]];
  };
  await a.insertRows(table, names, rows);
  assert.match(log[0], /^PUT 'file:\/\/.*\.json' @~\/moveit\/[0-9a-f-]+\/ AUTO_COMPRESS = TRUE OVERWRITE = TRUE$/);
  assert.match(log[1], /^COPY INTO ""\.""\."T" \("id", "amount", "name", "ok", "born", "seen", "doc", "raw"\) FROM \(SELECT /);
  assert.match(log[1], /CAST\(\(\$1:"id"::STRING\) AS NUMBER\(38,0\)\)/);
  assert.match(log[1], /CAST\(\(\$1:"amount"::STRING\) AS NUMBER\(12,2\)\)/);
  assert.match(log[1], /TO_DATE\(\(\$1:"born"::STRING\), 'YYYY-MM-DD'\)/);
  assert.match(log[1], /PARSE_JSON\(\(\$1:"doc"::STRING\)\)/);
  assert.match(log[1], /TO_BINARY\(\(\$1:"raw"::STRING\), 'HEX'\)/);
  assert.match(log[1], /FILE_FORMAT = \(TYPE = JSON\) ON_ERROR = ABORT_STATEMENT PURGE = TRUE$/);
  assert.match(log[2], /^REMOVE @~\/moveit\//);
  const first = JSON.parse(staged.split("\n")[0]);
  assert.equal(first.id, "1"); // numbers travel as strings so nothing is rounded on the way
  assert.equal(first.ok, "true");
  assert.equal(first.raw, "00ff10");
});

test("snowflake bulk load: a short COPY is an error, and the stage is still cleaned up", async () => {
  const a = new SnowflakeAdapter({ type: "snowflake", bulkLoad: true });
  const log: string[] = [];
  (a as any).exec = async (sql: string) => void log.push(sql);
  (a as any).query = async () => [["f.json.gz", "LOADED", 2, 1, 1, 0]];
  await assert.rejects(a.insertRows(table, names, rows), /COPY INTO loaded 1 of 2 rows/);
  assert.match(log[log.length - 1], /^REMOVE @~/);
  (a as any).query = async () => [["Copy executed with 0 files processed."]];
  await assert.rejects(a.insertRows(table, names, rows), /loaded 0 of 2/);
});

test("snowflake without bulkLoad keeps using INSERT", async () => {
  const a = new SnowflakeAdapter({ type: "snowflake" });
  assert.equal(a.preferredBatchSize, undefined);
  const sqls: string[] = [];
  (a as any).exec = async (s: string) => void sqls.push(s);
  await a.insertRows(table, names, [rows[1]]);
  assert.ok(sqls.some((s) => /^INSERT INTO/.test(s)));
  assert.ok(!sqls.some((s) => /COPY INTO/.test(s)));
});

test("databricks bulk load: PUT to the volume, INSERT from read_files with casts, REMOVE", async () => {
  const a = new DatabricksAdapter({ type: "databricks", bulkLoad: { volume: "/Volumes/main/raw/stage/" } });
  assert.equal(a.preferredBatchSize, 50000);
  const log: string[] = [];
  let staged = "";
  (a as any).session = {
    executeStatement: async (sql: string, opts: any) => {
      log.push(sql);
      assert.ok(Array.isArray(opts.stagingAllowedLocalPath));
      const m = /^PUT '(.+?)' INTO/.exec(sql);
      if (m) staged = readFileSync(m[1], "utf8");
      return { close: async () => undefined };
    },
  };
  (a as any).exec = async (sql: string) => void log.push(sql);
  await a.insertRows(table, names, rows);
  assert.match(log[0], /^PUT '.*\.json' INTO '\/Volumes\/main\/raw\/stage\/\.moveit\/[0-9a-f-]+\.json' OVERWRITE$/);
  assert.match(log[1], /^INSERT INTO ``\.``\.`T` \(`id`, `amount`, `name`, `ok`, `born`, `seen`, `doc`, `raw`\) SELECT /);
  assert.match(log[1], /CAST\(`id` AS BIGINT\)/);
  assert.match(log[1], /CAST\(`amount` AS DECIMAL\(12,2\)\)/);
  assert.match(log[1], /CAST\(`ok` AS BOOLEAN\)/);
  assert.match(log[1], /unhex\(`raw`\)/);
  assert.match(log[1], /FROM read_files\('\/Volumes\/main\/raw\/stage\/\.moveit\/[0-9a-f-]+\.json', format => 'json', schema => '`id` STRING, /);
  assert.match(log[2], /^REMOVE '\/Volumes\/main\/raw\/stage\/\.moveit\//);
  const first = JSON.parse(staged.split("\n")[0]);
  assert.equal(first.raw, "00ff10");
  assert.equal(first.ok, "true");
});

test("databricks bulk load: only a Unity Catalog volume path is accepted; otherwise inline INSERT is used", async () => {
  assert.throws(() => new DatabricksAdapter({ type: "databricks", bulkLoad: { volume: "/tmp/x" } }), /must look like/);
  assert.throws(() => new DatabricksAdapter({ type: "databricks", bulkLoad: { volume: "/Volumes/a/b/c'; DROP" } }), /must look like/);
  const a = new DatabricksAdapter({ type: "databricks" });
  const sqls: string[] = [];
  (a as any).exec = async (s: string) => void sqls.push(s);
  await a.insertRows(table, names, [rows[1]]);
  assert.match(sqls[0], /^INSERT INTO .* VALUES /);
});
