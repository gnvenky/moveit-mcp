import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIdent } from "../src/adapters/base.js";
import { sparkString, DatabricksAdapter, databricksToCanonical } from "../src/adapters/databricks.js";
import { MysqlAdapter, mysqlToCanonical } from "../src/adapters/mysql.js";
import { OracleAdapter, oracleToCanonical } from "../src/adapters/oracle.js";
import { PostgresAdapter, pgToCanonical } from "../src/adapters/postgres.js";
import { SnowflakeAdapter, snowflakeToCanonical } from "../src/adapters/snowflake.js";
import type { ColumnInfo, TableInfo } from "../src/types.js";
import { CANONICAL_TYPES } from "../src/types.js";

const col = (name: string, type: ColumnInfo["type"], o: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  nativeType: type,
  type,
  nullable: true,
  ...o,
});

const everyType: TableInfo = {
  name: "T",
  primaryKey: ["id"],
  columns: [
    col("id", "bigint", { nullable: false }),
    col("n", "integer"),
    col("d", "decimal", { precision: 12, scale: 3 }),
    col("d_unbounded", "decimal"),
    col("f", "float"),
    col("b", "boolean"),
    col("s", "string", { length: 40 }),
    col("s_unbounded", "string"),
    col("t", "text"),
    col("dt", "date"),
    col("tm", "time"),
    col("ts", "timestamp"),
    col("tz", "timestamptz"),
    col("j", "json"),
    col("bin", "binary"),
    col("u", "uuid"),
    col("unk", "unknown"),
  ],
};

test("every canonical type has DDL on every SQL dialect", () => {
  const adapters = [
    new OracleAdapter({ type: "oracle" }),
    new SnowflakeAdapter({ type: "snowflake" }),
    new DatabricksAdapter({ type: "databricks" }),
    new MysqlAdapter({ type: "mysql" }),
    new PostgresAdapter({ type: "postgres" }),
  ];
  for (const a of adapters) {
    for (const t of CANONICAL_TYPES) {
      const c = col("c", t, { precision: 10, scale: 2, length: 20 });
      assert.ok(a.ddlType(c, false).length > 0, `${a.kind} ${t}`);
      assert.ok(a.ddlType(c, true).length > 0, `${a.kind} ${t} pk`);
    }
    const ddl = a.ddlFor(everyType, { pkName: "pk_t" });
    assert.match(ddl, /CONSTRAINT .*pk_t.* PRIMARY KEY/i, a.kind);
  }
});

test("Oracle: identifiers, paging, DDL and type mapping", () => {
  const a = new OracleAdapter({ type: "oracle" });
  assert.equal(a.normalizeIdentifier("orderId"), "ORDER_ID");
  assert.equal(a.emptyStringIsNull, true);
  assert.equal(a.placeholder(3), ":3");
  assert.match((a as any).page(100, 200), /OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY/);
  const ddl = a.ddlFor(everyType, { pkName: "pk_t" });
  for (const frag of [
    'NUMBER(19,0) NOT NULL',
    "NUMBER(10,0)",
    "NUMBER(12,3)",
    "BINARY_DOUBLE",
    "NUMBER(1,0)",
    "VARCHAR2(40 CHAR)",
    "CLOB",
    "TIMESTAMP(6) WITH TIME ZONE",
    'CLOB CHECK ("j" IS JSON)',
    "BLOB",
    "VARCHAR2(36 CHAR)",
    'CONSTRAINT "pk_t" PRIMARY KEY ("id")',
  ])
    assert.ok(ddl.includes(frag), `missing ${frag}\n${ddl}`);
  assert.ok(!/\bLIMIT\b/.test(ddl));
  // placeholders convert text binds to the right type explicitly
  assert.equal(a.placeholderFor(col("x", "timestamptz"), 2), "TO_TIMESTAMP_TZ(:2, 'YYYY-MM-DD HH24:MI:SS.FF6TZH:TZM')");
  assert.equal(a.placeholderFor(col("x", "decimal"), 1), "TO_NUMBER(:1)");
  // type mapping
  assert.deepEqual(oracleToCanonical("NUMBER", null, 5, 0), { type: "integer" });
  assert.deepEqual(oracleToCanonical("NUMBER", null, 15, 0), { type: "bigint" });
  assert.deepEqual(oracleToCanonical("NUMBER", null, 38, 0), { type: "bigint" });
  assert.deepEqual(oracleToCanonical("NUMBER", null, 25, 0), { type: "decimal", precision: 25, scale: 0 });
  assert.deepEqual(oracleToCanonical("NUMBER", null, 10, 2), { type: "decimal", precision: 10, scale: 2 });
  assert.deepEqual(oracleToCanonical("NUMBER", null, null, null), { type: "decimal" });
  assert.deepEqual(oracleToCanonical("DATE", null, null, null), { type: "timestamp" });
  assert.deepEqual(oracleToCanonical("TIMESTAMP(6) WITH LOCAL TIME ZONE", null, null, null), { type: "timestamptz" });
  assert.deepEqual(oracleToCanonical("VARCHAR2", 30, null, null), { type: "string", length: 30 });
  assert.deepEqual(oracleToCanonical("CLOB", 0, null, null), { type: "text" });
  assert.deepEqual(oracleToCanonical("INTERVAL DAY(2) TO SECOND(6)", null, null, null), { type: "unknown" });
});

test("Oracle: describeTable reads catalog rows and maps them", async () => {
  class Fake extends OracleAdapter {
    async query(sql: string): Promise<unknown[][]> {
      if (sql.includes("all_tab_columns"))
        return [
          ["ID", "NUMBER", 22, 0, 10, 0, "N"],
          ["AMOUNT", "NUMBER", 22, 0, 12, 2, "Y"],
          ["NAME", "VARCHAR2", 200, 50, null, null, "Y"],
          ["CREATED", "DATE", 7, 0, null, null, "N"],
        ];
      if (sql.includes("all_constraints")) return [["ID"]];
      return [];
    }
  }
  const t = await new Fake({ type: "oracle", schema: "erp" }).describeTable("ORDERS");
  assert.deepEqual(t.primaryKey, ["ID"]);
  assert.deepEqual(
    t.columns.map((c) => [c.name, c.type, c.nullable]),
    [
      ["ID", "bigint", false],
      ["AMOUNT", "decimal", true],
      ["NAME", "string", true],
      ["CREATED", "timestamp", false],
    ],
  );
  assert.equal(t.columns[0].nativeType, "NUMBER(10)");
});

test("Oracle: reads cast numbers and timestamps to text so drivers cannot lose precision", () => {
  const a = new OracleAdapter({ type: "oracle" }) as any;
  assert.match(a.selectExpr({ ...col("AMT", "decimal"), nativeType: "NUMBER(12,2)" }), /TO_CHAR\("AMT", 'TM9'/);
  assert.match(a.selectExpr({ ...col("D", "timestamp"), nativeType: "DATE" }), /TO_CHAR\("D", 'YYYY-MM-DD"T"HH24:MI:SS'\)/);
  assert.match(a.selectExpr({ ...col("T", "timestamptz"), nativeType: "TIMESTAMP(6) WITH TIME ZONE" }), /AT TIME ZONE 'UTC'/);
});

test("Snowflake: inserts use SELECT ... UNION ALL with typed casts", () => {
  const a = new SnowflakeAdapter({ type: "snowflake" });
  const cols = [col("ID", "bigint"), col("DOC", "json"), col("RAW", "binary"), col("OK", "boolean"), col("AT", "timestamptz"), col("AMT", "decimal", { precision: 10, scale: 2 })];
  const { sql, params } = a.buildInsert("T", cols, [
    [1, '{"a":1}', Buffer.from("ff00", "hex"), true, "2024-01-01 00:00:00.000000+00:00", "1.50"],
    [2, null, null, false, null, null],
  ]);
  assert.ok(!/VALUES/.test(sql), sql);
  assert.equal(sql.split("UNION ALL").length, 2);
  assert.ok(sql.includes("PARSE_JSON(?)") && sql.includes("TO_BINARY(?, 'HEX')") && sql.includes("CAST(? AS NUMBER(10,2))"), sql);
  assert.equal(params.length, 12);
  assert.equal(params[2], "ff00"); // bytes are bound as hex text
  assert.equal(params[1 * 6 + 1], null);
  assert.equal(a.enforcesPrimaryKey, false);
  assert.equal(a.normalizeIdentifier("order_id"), "ORDER_ID");
  assert.ok(a.maxInsertRows(6) * 6 <= 16384);
});

test("Snowflake: type mapping and describeTable", async () => {
  assert.deepEqual(snowflakeToCanonical("NUMBER", null, 38, 0), { type: "bigint" });
  assert.deepEqual(snowflakeToCanonical("NUMBER", null, 9, 0), { type: "integer" });
  assert.deepEqual(snowflakeToCanonical("NUMBER", null, 18, 4), { type: "decimal", precision: 18, scale: 4 });
  assert.deepEqual(snowflakeToCanonical("TEXT", 16777216, null, null), { type: "string" });
  assert.deepEqual(snowflakeToCanonical("TEXT", 50, null, null), { type: "string", length: 50 });
  assert.deepEqual(snowflakeToCanonical("TIMESTAMP_LTZ", null, null, null), { type: "timestamptz" });
  assert.deepEqual(snowflakeToCanonical("VARIANT", null, null, null), { type: "json" });
  const statements: string[] = [];
  class Fake extends SnowflakeAdapter {
    async query(sql: string): Promise<unknown[][]> {
      if (sql.includes("information_schema.columns")) return [["ID", "NUMBER", null, 38, 0, "NO"], ["NAME", "TEXT", 100, null, null, "YES"]];
      if (sql.includes("RESULT_SCAN")) return [["ID", 1]];
      return [];
    }
    async exec(sql: string): Promise<void> {
      statements.push(sql);
    }
  }
  const f = new Fake({ type: "snowflake" });
  (f as any).database = "DB";
  (f as any).schema = "PUBLIC";
  const t = await f.describeTable("ORDERS");
  assert.deepEqual(t.primaryKey, ["ID"]);
  assert.ok(statements.some((s) => s.startsWith('SHOW PRIMARY KEYS IN TABLE "DB"."PUBLIC"."ORDERS"')));
  assert.equal(t.columns[1].length, 100);
});

test("Databricks: string literals cannot be broken out of", () => {
  const attack = "x'); DROP TABLE users; --";
  const lit = sparkString(attack);
  assert.ok(!lit.includes("DROP"), lit);
  assert.match(lit, /^decode\(unhex\('[0-9a-f]+'\), 'UTF-8'\)$/);
  assert.equal(Buffer.from(lit.match(/unhex\('([0-9a-f]+)'\)/)![1], "hex").toString(), attack);
  assert.equal(sparkString("plain text"), "'plain text'");
  assert.match(sparkString("back\\slash"), /^decode/);
  assert.match(sparkString("emoji 😀 and\nnewline"), /^decode/);
  assert.match(sparkString(""), /^''$/);
});

test("Databricks: inline inserts validate every literal", () => {
  const a = new DatabricksAdapter({ type: "databricks" });
  const cols = [col("id", "bigint"), col("amt", "decimal", { precision: 10, scale: 2 }), col("ts", "timestamp"), col("tz", "timestamptz"), col("b", "binary"), col("s", "string"), col("f", "float")];
  const { sql, params } = a.buildInsert("t", cols, [["9007199254740993", "1.50", "2024-01-01 00:00:00.000000", "2024-01-01 00:00:00.000000+00:00", Buffer.from("0aff", "hex"), "it's", 1.5], [null, null, null, null, null, null, null]]);
  assert.equal(params.length, 0);
  for (const frag of ["9007199254740993", "1.50", "TIMESTAMP_NTZ'2024-01-01 00:00:00.000000'", "TIMESTAMP'2024-01-01 00:00:00.000000+00:00'", "X'0aff'", "NULL, NULL"])
    assert.ok(sql.includes(frag), `missing ${frag}\n${sql}`);
  assert.ok(!sql.includes("it's"));
  assert.throws(() => a.buildInsert("t", [col("id", "integer")], [["1; DROP TABLE t"]]), /non-integer/);
  assert.throws(() => a.buildInsert("t", [col("f", "float")], [[Number.NaN]]), /non-finite/);
  assert.throws(() => a.buildInsert("t", [col("d", "date")], [["2024-01-01' OR '1"]]), /Bad date/);
  // reads are aliased by position and lossy types are cast to text
  const sel = (a as any).selectExpr(col("amt", "decimal", { precision: 10, scale: 2 }), 3) as string;
  assert.match(sel, /CAST\(`amt` AS STRING\) AS `c3`/);
  assert.match(a.ddlFor(everyType), /USING DELTA$/);
});

test("Databricks: type mapping", () => {
  assert.deepEqual(databricksToCanonical("decimal(10,2)"), { type: "decimal", precision: 10, scale: 2 });
  assert.deepEqual(databricksToCanonical("TIMESTAMP_NTZ"), { type: "timestamp" });
  assert.deepEqual(databricksToCanonical("timestamp"), { type: "timestamptz" });
  assert.deepEqual(databricksToCanonical("array<string>"), { type: "json" });
  assert.deepEqual(databricksToCanonical("map<string,int>"), { type: "json" });
  assert.deepEqual(databricksToCanonical("struct<a:int,b:array<string>>"), { type: "json" });
  assert.deepEqual(databricksToCanonical("interval day to second"), { type: "unknown" });
  assert.deepEqual(databricksToCanonical("ARRAY"), { type: "json" });
  assert.deepEqual(databricksToCanonical("bigint"), { type: "bigint" });
});

test("MySQL and Postgres: mapping and quoting", () => {
  assert.deepEqual(mysqlToCanonical("tinyint", "tinyint(1)", null, 3, 0), { type: "boolean" });
  assert.deepEqual(mysqlToCanonical("int", "int unsigned", null, 10, 0), { type: "bigint" });
  assert.deepEqual(mysqlToCanonical("bigint", "bigint unsigned", null, 20, 0), { type: "decimal", precision: 20, scale: 0 });
  assert.deepEqual(mysqlToCanonical("datetime", "datetime(6)", null, null, null), { type: "timestamp" });
  assert.deepEqual(mysqlToCanonical("timestamp", "timestamp", null, null, null), { type: "timestamptz" });
  assert.deepEqual(pgToCanonical("numeric", "numeric", null, 12, 4), { type: "decimal", precision: 12, scale: 4 });
  assert.deepEqual(pgToCanonical("timestamp with time zone", "timestamptz", null, null, null), { type: "timestamptz" });
  assert.deepEqual(pgToCanonical("ARRAY", "_int4", null, null, null), { type: "json" });
  assert.equal(new MysqlAdapter({ type: "mysql" }).quote("a`b"), "`a``b`");
  assert.equal(new PostgresAdapter({ type: "postgres" }).quote('a"b'), '"a""b"');
  const my = new MysqlAdapter({ type: "mysql" });
  assert.match(my.ddlFor({ name: "t", primaryKey: ["k"], columns: [col("k", "string", { nullable: false }), col("v", "decimal")] }), /`k` VARCHAR\(255\) NOT NULL/);
  assert.match(my.ddlFor({ name: "t", primaryKey: [], columns: [col("v", "decimal")] }), /DECIMAL\(65,30\)/);
});

test("identifier normalisation", () => {
  assert.equal(normalizeIdent("orderId", "lower"), "order_id");
  assert.equal(normalizeIdent("Full Name", "upper"), "FULL_NAME");
  assert.equal(normalizeIdent("  ", "lower"), "col");
  assert.equal(normalizeIdent("Keep Me", "preserve"), "Keep Me");
});
