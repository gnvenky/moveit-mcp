// Live integration test against a real PostgreSQL. Skipped unless MOVEIT_TEST_PG is set, e.g.
//   MOVEIT_TEST_PG=postgres://postgres@127.0.0.1:5432  (needs databases moveit_src and moveit_dst)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { Connections, type MoveitConfig } from "../src/config.js";
import { Moveit } from "../src/service.js";
import { Store } from "../src/store.js";

const BASE = process.env.MOVEIT_TEST_PG;
const skip = BASE ? false : "set MOVEIT_TEST_PG to run";
const url = (db: string) => `${BASE}/${db}`;

async function sql(db: string, text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url(db) });
  await c.connect();
  try {
    await c.query("SET TIME ZONE 'UTC'");
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

const N = 3000;
async function seed() {
  for (const db of ["moveit_src", "moveit_dst"]) await sql(db, "DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await sql(
    "moveit_src",
    `CREATE TYPE mood AS ENUM ('happy','sad');
     CREATE TABLE "Wide Table" (
       id bigserial PRIMARY KEY, small smallint, int4 integer NOT NULL, money_amt numeric(12,3), huge numeric,
       r real, d double precision, flag boolean, code varchar(20), body text, born date, at_time time,
       created timestamp, seen timestamptz, doc json, docb jsonb, raw bytea, uid uuid, nums int[], feeling mood,
       "select" text);
     CREATE TABLE line_items (order_id integer, line integer, sku text NOT NULL, qty integer, PRIMARY KEY (order_id, line));
     CREATE TABLE no_key (a integer, b text);
     CREATE TABLE empty_table (id integer PRIMARY KEY, v text);`,
  );
  await sql(
    "moveit_src",
    `INSERT INTO "Wide Table" (small, int4, money_amt, huge, r, d, flag, code, body, born, at_time, created, seen, doc, docb, raw, uid, nums, feeling, "select")
     SELECT (i % 30000)::smallint, i * 1000 - 1500000, (i * 1.37)::numeric(12,3),
            CASE WHEN i % 3 = 0 THEN 12345678901234567890.123456789 + i ELSE NULL END,
            (i / 3.0)::real, i / 7.0, i % 2 = 0,
            'code' || (i % 1000),
            CASE WHEN i % 7 = 0 THEN E'multi\\nline, "quoted" ''single'' tab\\t 日本語 😀 \\\\ backslash' WHEN i % 11 = 0 THEN '' WHEN i % 13 = 0 THEN NULL ELSE 'note ' || i END,
            DATE '2000-01-01' + (i % 9000), TIME '00:00:00' + (i % 86400) * INTERVAL '1 second' + (i % 1000) * INTERVAL '1 millisecond',
            TIMESTAMP '2020-01-01 00:00:00' + i * INTERVAL '1 minute' + (i % 1000) * INTERVAL '1 microsecond',
            TIMESTAMPTZ '2020-01-01 00:00:00+00' + i * INTERVAL '37 seconds' + (i % 999999) * INTERVAL '1 microsecond',
            json_build_object('z', i, 'a', json_build_array(1, 2, i), 'n', NULL)::json, jsonb_build_object('k', i, 'b', 'x'),
            decode(lpad(to_hex(i), 8, '0'), 'hex'), md5(i::text)::uuid, ARRAY[i, i + 1, NULL], CASE WHEN i % 2 = 0 THEN 'happy'::mood ELSE 'sad'::mood END,
            'reserved word column ' || i
       FROM generate_series(1, ${N}) i;
     INSERT INTO line_items SELECT i / 4 + 1, i % 4 + 1, 'sku-' || i, i % 10 FROM generate_series(0, 999) i;
     INSERT INTO no_key SELECT i, CASE WHEN i % 2 = 0 THEN 'dup' ELSE NULL END FROM generate_series(1, 50) i;`,
  );
}

const openConns: Connections[] = [];
const after_ = (c: Connections) => void openConns.push(c);
after(async () => {
  for (const c of openConns) await c.closeAll();
});

function app() {
  const config: MoveitConfig = {
    connections: {
      src: { type: "postgres", url: url("moveit_src"), readOnly: true },
      dst: { type: "postgres", url: url("moveit_dst") },
    },
  };
  const conns = new Connections(config);
  const dir = mkdtempSync(join(tmpdir(), "moveit-pg-"));
  return { dir, conns, app: new Moveit(config, conns, new Store(join(dir, ".moveit"))) };
}

/** Independent check: hash every row inside Postgres itself, no moveit code involved. */
const rowHash = (table: string) =>
  `SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) h, count(*)::int n FROM "${table}" t`;

test("PG -> PG: every type survives, verified by an independent in-database hash", { skip }, async () => {
  await seed();
  const t = app();
  after_(t.conns);
  const { plan } = await t.app.plan({ source: "src", target: "dst" });
  assert.deepEqual(plan.tables.map((x) => x.targetTable).sort(), ["Wide Table", "empty_table", "line_items", "no_key"]);
  assert.ok(plan.issues.every((i) => i.severity !== "error"), JSON.stringify(plan.issues.filter((i) => i.severity === "error")));
  const dr = await t.app.dryRun(plan.id);
  assert.ok(dr.ok, JSON.stringify(dr.tables.filter((x) => x.rowsFailed)));
  const run = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 700 });
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)));
  assert.ok(run.tables.every((x) => x.verify?.ok));
  assert.equal(run.tables.find((x) => x.sourceTable === "Wide Table")!.rowsLoaded, N);
  for (const tb of ["line_items", "no_key", "empty_table"]) {
    const [a] = await sql("moveit_src", rowHash(tb));
    const [b] = await sql("moveit_dst", rowHash(tb));
    assert.deepEqual(b, a, tb);
  }
  // the wide table: json columns become jsonb, so compare the jsonb-normalised row
  const cols = `to_jsonb(t) - 'doc' - 'nums' - 'feeling' || jsonb_build_object('doc', doc::jsonb, 'nums', to_jsonb(nums), 'feeling', feeling::text)`;
  const wide = `SELECT md5(string_agg((${cols})::text, '|' ORDER BY id)) h, count(*)::int n FROM "Wide Table" t`;
  const [a] = await sql("moveit_src", wide);
  const [b] = await sql("moveit_dst", wide);
  assert.deepEqual(b, a);
  assert.equal(a.n, N);
  // primary keys and exact values
  const keys = await sql("moveit_dst", `SELECT conrelid::regclass::text t, pg_get_constraintdef(oid) d FROM pg_constraint WHERE contype='p' ORDER BY 1`);
  assert.ok(keys.some((k) => k.t === "line_items" && /PRIMARY KEY \(order_id, line\)/.test(k.d)), JSON.stringify(keys));
  const [big] = await sql("moveit_dst", `SELECT huge::text h FROM "Wide Table" WHERE id = 3`);
  assert.equal(big.h, "12345678901234567893.123456789"); // far beyond float precision, still exact
  assert.equal((await sql("moveit_dst", `SELECT count(*)::int n FROM "Wide Table" WHERE body = ''`))[0].n, (await sql("moveit_src", `SELECT count(*)::int n FROM "Wide Table" WHERE body = ''`))[0].n);
  assert.equal((await sql("moveit_dst", `SELECT count(*)::int n FROM pg_tables WHERE tablename LIKE '\\_moveit\\_%'`))[0].n, 0); // no staging left behind
  assert.equal((await t.app.reconcile(plan.id)).ok, true);
  // source was opened read-only: it must be untouched
  assert.equal((await sql("moveit_src", `SELECT count(*)::int n FROM "Wide Table"`))[0].n, N);
  await t.conns.closeAll();
});

test("PG: a flipped bit in the loaded data is caught by reconcile", { skip }, async () => {
  await seed();
  const t = app();
  after_(t.conns);
  const { plan } = await t.app.plan({ source: "src", target: "dst", tables: ["line_items"] });
  await t.app.dryRun(plan.id);
  const run = await t.app.run(plan.id, { planHash: plan.hash });
  assert.equal(run.status, "succeeded");
  await sql("moveit_dst", `UPDATE line_items SET sku = sku || 'x' WHERE order_id = 5 AND line = 2`);
  const rec = await t.app.reconcile(plan.id);
  assert.equal(rec.ok, false);
  assert.deepEqual(rec.tables[0].verify!.mismatchedColumns, ["sku"]);
  await t.conns.closeAll();
});

test("PG: target that already exists blocks the plan; duplicate keys block the dry run", { skip }, async () => {
  await seed();
  await sql("moveit_dst", "CREATE TABLE line_items (x int)");
  const t = app();
  after_(t.conns);
  const p1 = await t.app.plan({ source: "src", target: "dst", tables: ["line_items"] });
  assert.ok(p1.plan.issues.some((i) => i.code === "target_exists"));
  // no_key has duplicate values in b; declaring b as the key must be rejected before anything is written
  const p2 = await t.app.plan({ source: "src", target: "dst", tables: ["no_key"], overrides: [{ source: "no_key", primaryKey: ["b"] }] });
  const dr = await t.app.dryRun(p2.plan.id);
  assert.equal(dr.ok, false);
  assert.ok(dr.tables[0].failures.some((f) => f.code === "duplicate_key"), JSON.stringify(dr.tables[0].failures));
  await assert.rejects(t.app.run(p2.plan.id, { planHash: p2.plan.hash }), /cannot be migrated/);
  assert.equal((await sql("moveit_dst", `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`))[0].n, 1);
  await t.conns.closeAll();
});

test("SQLite -> PG and PG -> CSV -> PG keep the data", { skip }, async () => {
  await seed();
  const t = app();
  after_(t.conns);
  const dir = mkdtempSync(join(tmpdir(), "moveit-x-"));
  const lite = new DatabaseSync(join(dir, "s.db"));
  lite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price DECIMAL(10,2), ok BOOLEAN, seen TIMESTAMP, extra BLOB)");
  const ins = lite.prepare("INSERT INTO t VALUES (?,?,?,?,?,?)");
  for (let i = 1; i <= 500; i++) ins.run(i, `n${i} é`, (i / 8).toFixed(2), i % 2, `2026-02-0${(i % 9) + 1} 01:02:03`, Buffer.from([i % 256, 0, 255]));
  lite.close();
  const config: MoveitConfig = {
    connections: {
      lite: { type: "sqlite", path: join(dir, "s.db") },
      dst: { type: "postgres", url: url("moveit_dst") },
      src: { type: "postgres", url: url("moveit_src") },
      csv: { type: "csv", path: join(dir, "csv") },
    },
  };
  const conns = new Connections(config);
  after_(conns);
  const a = new Moveit(config, conns, new Store(join(dir, ".m")));
  const p = await a.plan({ source: "lite", target: "dst" });
  assert.ok((await a.dryRun(p.plan.id)).ok);
  assert.equal((await a.run(p.plan.id, { planHash: p.plan.hash })).status, "succeeded");
  const cols = await sql("moveit_dst", `SELECT column_name c, data_type d FROM information_schema.columns WHERE table_name='t' ORDER BY ordinal_position`);
  assert.deepEqual(cols.map((c) => c.d), ["bigint", "text", "numeric", "boolean", "timestamp without time zone", "bytea"]);
  assert.equal((await sql("moveit_dst", `SELECT encode(extra,'hex') h FROM t WHERE id = 300`))[0].h, "2c00ff");
  // PG -> CSV (with emoji, newlines, quotes, NULL vs '') -> PG
  const c1 = await a.plan({ source: "src", target: "csv", tables: ["line_items", "empty_table"] });
  assert.ok((await a.dryRun(c1.plan.id)).ok);
  assert.equal((await a.run(c1.plan.id, { planHash: c1.plan.hash })).status, "succeeded");
  assert.match(readFileSync(join(dir, "csv", "line_items.csv"), "utf8"), /^order_id,line,sku,qty\n/);
  await sql("moveit_dst", `DROP TABLE line_items`).catch(() => {});
  const c2 = await a.plan({ source: "csv", target: "dst", tables: ["line_items"], overrides: [{ source: "line_items", primaryKey: ["order_id", "line"] }] });
  assert.ok((await a.dryRun(c2.plan.id)).ok);
  assert.equal((await a.run(c2.plan.id, { planHash: c2.plan.hash })).status, "succeeded");
  const [x] = await sql("moveit_src", rowHash("line_items"));
  const [y] = await sql("moveit_dst", rowHash("line_items"));
  assert.deepEqual(y, x);
  await conns.closeAll();
  await t.conns.closeAll();
});
