// Live tests of identity, defaults, indexes, foreign keys, snapshots, replace/append and resume against a real PostgreSQL.
// Skipped unless MOVEIT_TEST_PG is set (needs databases moveit_src and moveit_dst), like postgres.live.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

const SCHEMA = `
  CREATE TABLE customers (
    id serial PRIMARY KEY,
    email varchar(80) NOT NULL,
    status varchar(10) NOT NULL DEFAULT 'new',
    score integer DEFAULT 5,
    active boolean DEFAULT true,
    created timestamptz DEFAULT now(),
    born date DEFAULT CURRENT_DATE,
    token uuid DEFAULT gen_random_uuid(),
    ratio numeric(5,2) DEFAULT 1.50
  );
  CREATE UNIQUE INDEX ux_customers_email ON customers (email);
  CREATE INDEX ix_customers_status_score ON customers (status, score);
  CREATE INDEX ix_partial ON customers (score) WHERE active;
  CREATE INDEX ix_expr ON customers (lower(email));
  CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    referrer_id integer REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    total numeric(10,2)
  );
  CREATE INDEX ix_orders_customer ON orders (customer_id);
  CREATE TABLE order_lines (
    order_id bigint, line integer, sku text,
    PRIMARY KEY (order_id, line),
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );
  CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
  CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER trg_touch BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION touch();
  CREATE SEQUENCE loose_seq;
`;

async function seed() {
  for (const db of ["moveit_src", "moveit_dst"]) await sql(db, "DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await sql("moveit_src", SCHEMA);
  await sql(
    "moveit_src",
    `INSERT INTO customers (email, status, score) SELECT 'c' || i || '@x.io', CASE WHEN i % 2 = 0 THEN 'vip' ELSE 'new' END, i FROM generate_series(1, 260) i;
     DELETE FROM customers WHERE id > 250;
     INSERT INTO orders (customer_id, referrer_id, total) SELECT (i % 250) + 1, CASE WHEN i % 3 = 0 THEN ((i + 7) % 250) + 1 END, i * 1.25 FROM generate_series(1, 600) i;
     INSERT INTO order_lines SELECT (i % 600) + 1, i / 600 + 1, 'sku' || i FROM generate_series(0, 1199) i;`,
  );
}

function appFor(srcOpts: Record<string, unknown> = {}) {
  const config: MoveitConfig = {
    connections: {
      src: { type: "postgres", url: url("moveit_src"), readOnly: true, ...srcOpts },
      tgt: { type: "postgres", url: url("moveit_dst") },
    },
  };
  const conns = new Connections(config);
  const app = new Moveit(config, conns, new Store(mkdtempSync(join(tmpdir(), "moveit-pgobj-"))));
  return { app, conns };
}

async function planRun(app: Moveit, opts: Parameters<Moveit["plan"]>[0], run: Partial<Parameters<Moveit["run"]>[1]> = {}) {
  const { plan } = await app.plan(opts);
  const errors = plan.issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const dr = await app.dryRun(plan.id);
  assert.ok(dr.ok, JSON.stringify(dr.tables.map((t) => t.failures)));
  return { plan, run: await app.run(plan.id, { planHash: plan.hash, ...run }) };
}

const q = async (db: string, text: string, params: unknown[] = []) => sql(db, text, params);

test("PG -> PG carries identity, defaults, indexes and foreign keys; lists what it leaves behind", { skip }, async () => {
  await seed();
  const { app, conns } = appFor();
  try {
    const { plan, run } = await planRun(app, { source: "src", target: "tgt" });
    assert.equal(run.status, "succeeded", JSON.stringify([run.error, run.tables.map((t) => t.error)]));
    assert.equal(run.snapshot, "consistent");
    assert.equal(run.constraintFailures.length, 0, JSON.stringify(run.constraintFailures));

    const byTable = Object.fromEntries(plan.tables.map((t) => [t.sourceTable, t]));
    assert.equal(byTable.customers.identity?.column, "id"); // a serial column
    assert.equal(byTable.orders.identity?.column, "id"); // GENERATED ALWAYS AS IDENTITY
    assert.equal(byTable.order_lines.identity, undefined);
    assert.deepEqual(byTable.customers.indexes.map((i) => i.name).sort(), ["ix_customers_status_score", "ux_customers_email"]);
    assert.ok(plan.issues.some((i) => /partial indexes/.test(i.message)));
    assert.ok(plan.issues.some((i) => /expression indexes/.test(i.message)));
    assert.ok(plan.issues.some((i) => /gen_random_uuid/.test(i.message)), "non-portable default is reported");
    assert.deepEqual(plan.inventory.map((o) => `${o.kind}:${o.name}`).sort(), ["routine:touch", "sequence:loose_seq", "trigger:trg_touch", "view:big_orders"]);

    // indexes exist in the target, nothing extra
    const idx = (await q("moveit_dst", "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('customers','orders') AND indexname NOT LIKE 'pk_%' ORDER BY 1")).map((r) => r.indexname);
    assert.deepEqual(idx, ["ix_customers_status_score", "ix_orders_customer", "ux_customers_email"]);
    // foreign keys, with their actions
    const fks = await q("moveit_dst", "SELECT conrelid::regclass::text AS t, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 2");
    assert.equal(fks.length, 3);
    assert.ok(fks.some((f) => f.t === "orders" && /\(customer_id\) REFERENCES customers\(id\) ON DELETE CASCADE/.test(f.d)));
    assert.ok(fks.some((f) => f.t === "orders" && /\(referrer_id\) REFERENCES customers\(id\) ON UPDATE CASCADE ON DELETE SET NULL/.test(f.d)));
    assert.ok(fks.some((f) => f.t === "order_lines" && /\(order_id\) REFERENCES orders\(id\)/.test(f.d)));
    // every table still matches the source before we start inserting into it
    const rec = await app.reconcile(plan.id);
    assert.ok(rec.ok, JSON.stringify(rec.tables.map((t) => [t.table, t.verify?.ok])));
    // defaults and identity behave on new rows
    const ins = await q("moveit_dst", "INSERT INTO customers (email) VALUES ('fresh@x.io') RETURNING *");
    assert.equal(ins[0].id, 251); // continues after the highest copied key, though the source sequence was at 260
    assert.equal(ins[0].status, "new");
    assert.equal(ins[0].score, 5);
    assert.equal(ins[0].active, true);
    assert.equal(ins[0].ratio, "1.50");
    assert.equal(ins[0].token, null); // gen_random_uuid() was not carried
    assert.ok(Math.abs(new Date(ins[0].created).getTime() - Date.now()) < 60_000);
    const o = await q("moveit_dst", "INSERT INTO orders (customer_id, total) VALUES (1, 1) RETURNING id");
    assert.equal(String(o[0].id), "601");
    const kinds = await q("moveit_dst", "SELECT table_name, is_identity FROM information_schema.columns WHERE column_name = 'id' AND table_name IN ('customers','orders') ORDER BY 1");
    assert.deepEqual(kinds.map((k) => k.is_identity), ["YES", "YES"]);
    // the view, trigger, function and sequence were not created
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_views WHERE schemaname = 'public'"))[0].c, 0);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_trigger WHERE NOT tgisinternal"))[0].c, 0);
    const md = app.report(run.id).markdown;
    assert.match(md, /ix_customers_status_score/);
    assert.match(md, /big_orders/);
  } finally {
    await conns.closeAll();
  }
});

test("PG snapshot: writes during the copy do not leak in, and reconcile shows the drift afterwards", { skip }, async () => {
  await seed();
  const { app, conns } = appFor();
  try {
    const { plan } = await app.plan({ source: "src", target: "tgt", tables: ["customers"] });
    await app.dryRun(plan.id);
    const tgt: any = await conns.get("tgt");
    const orig = tgt.insertRows.bind(tgt);
    let wrote = false;
    tgt.insertRows = async (...a: unknown[]) => {
      await orig(...a);
      if (!wrote) {
        wrote = true;
        await sql("moveit_src", "UPDATE customers SET score = 9999 WHERE id = 7; INSERT INTO customers (email) VALUES ('late@x.io'); UPDATE customers SET email = 'changed@x.io' WHERE id = 8");
      }
    };
    const run = await app.run(plan.id, { planHash: plan.hash, batchSize: 40 });
    assert.equal(run.status, "succeeded", JSON.stringify([run.error, run.tables.map((t) => t.error)]));
    assert.equal(run.snapshot, "consistent");
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers"))[0].c, 250);
    assert.equal((await q("moveit_dst", "SELECT score FROM customers WHERE id = 7"))[0].score, 7);
    assert.equal((await q("moveit_dst", "SELECT email FROM customers WHERE id = 8"))[0].email, "c8@x.io"); // not the later edit
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers WHERE email = 'late@x.io'"))[0].c, 0);
    assert.ok(run.warnings.some((w) => /251 rows now/.test(w)));
    assert.equal((await app.reconcile(plan.id)).ok, false);
  } finally {
    await conns.closeAll();
  }
});

test("PG resume: stray rows from a crashed batch are detected, the table restarts, nothing is duplicated", { skip }, async () => {
  await seed();
  const { app, conns } = appFor();
  try {
    const { plan } = await app.plan({ source: "src", target: "tgt", tables: ["customers"] });
    await app.dryRun(plan.id);
    const part = await app.run(plan.id, { planHash: plan.hash, batchSize: 50, maxBatches: 2 });
    assert.equal(part.status, "partial");
    const staging = part.tables[0].stagingTable;
    await sql("moveit_dst", `INSERT INTO "${staging}" (id, email) VALUES (101, 'stray1@x'), (102, 'stray2@x')`);
    const done = await app.run(plan.id, { planHash: plan.hash, resumeRunId: part.id, batchSize: 50 });
    assert.equal(done.status, "succeeded", JSON.stringify([done.error, done.tables.map((t) => t.error)]));
    assert.ok(done.warnings.some((w) => /restarted this table/.test(w)));
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers"))[0].c, 250);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers WHERE email LIKE 'stray%'"))[0].c, 0);
    assert.equal(done.snapshot, "interrupted");
  } finally {
    await conns.closeAll();
  }
});

test("PG replace: new tables swapped in with their indexes and keys, backups kept, finalize drops them in dependency order", { skip }, async () => {
  await seed();
  const { app, conns } = appFor();
  try {
    const first = await planRun(app, { source: "src", target: "tgt" });
    assert.equal(first.run.status, "succeeded");
    await q("moveit_dst", "INSERT INTO customers (email, status) VALUES ('only-in-old@x.io', 'old')");

    const { plan, run } = await planRun(app, { source: "src", target: "tgt", mode: "replace" });
    assert.equal(plan.mode, "replace");
    assert.equal(run.status, "succeeded", JSON.stringify([run.error, run.tables.map((t) => t.error)]));
    assert.equal(run.constraintFailures.length, 0, JSON.stringify(run.constraintFailures));
    const backups = run.tables.map((t) => t.backupTable!);
    assert.equal(backups.length, 3);
    assert.equal((await q("moveit_dst", `SELECT count(*)::int c FROM "${run.tables.find((t) => t.targetTable === "customers")!.backupTable}" WHERE email = 'only-in-old@x.io'`))[0].c, 1);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers"))[0].c, 250); // the extra row is gone from the live table
    const nonPk = (t: string) => q("moveit_dst", "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname NOT LIKE 'pk%' ORDER BY 1", [t]);
    const fresh = (await nonPk("customers")).map((r) => r.indexname);
    assert.equal(fresh.length, 2); // the new table has both indexes...
    const kept = (await nonPk(run.tables.find((t) => t.targetTable === "customers")!.backupTable!)).map((r) => r.indexname);
    assert.deepEqual(kept.sort(), ["ix_customers_status_score", "ux_customers_email"]); // ...the backup kept its own...
    assert.ok(fresh.every((n) => !kept.includes(n)), "...under different names, so nothing clashed");
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_constraint c WHERE contype = 'f' AND conrelid = 'orders'::regclass"))[0].c, 2);

    const fin = await app.finalize(run.id, run.id);
    assert.equal(fin.finalized, true);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_tables WHERE tablename LIKE '_moveit_%'"))[0].c, 0);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers"))[0].c, 250);
  } finally {
    await conns.closeAll();
  }
});

test("PG replace rollback restores the old tables exactly", { skip }, async () => {
  await seed();
  const { app, conns } = appFor();
  try {
    await planRun(app, { source: "src", target: "tgt" });
    await q("moveit_dst", "INSERT INTO customers (email, status) VALUES ('only-in-old@x.io', 'old')");
    const before = (await q("moveit_dst", "SELECT md5(string_agg(id || email, ',' ORDER BY id)) h FROM customers"))[0].h;
    const { run } = await planRun(app, { source: "src", target: "tgt", mode: "replace" });
    assert.equal(run.status, "succeeded");
    await app.rollback(run.id, run.id);
    assert.equal((await q("moveit_dst", "SELECT md5(string_agg(id || email, ',' ORDER BY id)) h FROM customers"))[0].h, before);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_tables WHERE tablename LIKE '_moveit_%'"))[0].c, 0);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_constraint WHERE contype = 'f'"))[0].c, 3); // the original keys, not duplicates
  } finally {
    await conns.closeAll();
  }
});

test("PG replace is refused when a table outside the plan has a foreign key into it", { skip }, async () => {
  await seed();
  const { app, conns } = appFor();
  try {
    await planRun(app, { source: "src", target: "tgt" });
    const { plan } = await app.plan({ source: "src", target: "tgt", mode: "replace", tables: ["customers"] });
    assert.ok(plan.issues.some((i) => i.code === "replace_referenced" && i.severity === "error" && /orders/.test(i.message)));
  } finally {
    await conns.closeAll();
  }
});

test("PG append: key collisions stop it, a clean append moves the serial counter, rollback removes exactly the appended rows", { skip }, async () => {
  await seed();
  // a target that already holds a few customers, with a serial key like the source's
  await sql("moveit_dst", SCHEMA.split("CREATE UNIQUE INDEX")[0]); // just the customers table
  await sql("moveit_dst", "INSERT INTO customers (id, email) VALUES (1000, 'a@t'), (1001, 'b@t'), (1002, 'c@t')");
  await sql("moveit_dst", "SELECT setval('customers_id_seq', 1002)");
  const { app, conns } = appFor();
  try {
    // collision: pre-seed an id that the source also has
    await sql("moveit_dst", "INSERT INTO customers (id, email) VALUES (5, 'clash@t')");
    const c = await planRun(app, { source: "src", target: "tgt", mode: "append", tables: ["customers"] });
    assert.equal(c.run.status, "failed");
    assert.match(c.run.error ?? "", /1 row\(s\) of customers have keys that already exist/);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers"))[0].c, 4);
    await app.rollback(c.run.id, c.run.id);
    await sql("moveit_dst", "DELETE FROM customers WHERE id = 5");

    const { plan, run } = await planRun(app, { source: "src", target: "tgt", mode: "append", tables: ["customers"] });
    assert.deepEqual(plan.tables[0].appendKey, ["id"]);
    assert.equal(run.status, "succeeded", JSON.stringify([run.error, run.tables.map((t) => t.error)]));
    assert.equal(run.tables[0].targetCountBefore, 3);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM customers"))[0].c, 253);
    // the counter moved past the appended ids, so the next insert does not collide
    const next = await q("moveit_dst", "INSERT INTO customers (email) VALUES ('after@t') RETURNING id");
    assert.equal(next[0].id, 1003);
    await sql("moveit_dst", "DELETE FROM customers WHERE email = 'after@t'");

    await app.rollback(run.id, run.id);
    const left = await q("moveit_dst", "SELECT id FROM customers ORDER BY id");
    assert.deepEqual(left.map((r) => r.id), [1000, 1001, 1002]);
    assert.equal((await q("moveit_dst", "SELECT count(*)::int c FROM pg_tables WHERE tablename LIKE '_moveit_%'"))[0].c, 0);
  } finally {
    await conns.closeAll();
  }
});

test("SQLite AUTOINCREMENT -> PG identity, and PG serial -> SQLite rowid key, both continue after the highest value", { skip }, async () => {
  await seed();
  const dir = mkdtempSync(join(tmpdir(), "moveit-xdb-"));
  const { DatabaseSync } = await import("node:sqlite");
  const lite = new DatabaseSync(join(dir, "src.db"));
  lite.exec("CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT 'x')");
  for (let i = 0; i < 30; i++) lite.prepare("INSERT INTO things (name) VALUES (?)").run(`t${i}`);
  lite.close();
  const config: MoveitConfig = {
    connections: {
      lite: { type: "sqlite", path: join(dir, "src.db") },
      pgsrc: { type: "postgres", url: url("moveit_src"), readOnly: true },
      pgdst: { type: "postgres", url: url("moveit_dst") },
      lite2: { type: "sqlite", path: join(dir, "dst.db") },
    },
  };
  const conns = new Connections(config);
  const app = new Moveit(config, conns, new Store(join(dir, ".moveit")));
  try {
    const a = await planRun(app, { source: "lite", target: "pgdst" });
    assert.equal(a.run.status, "succeeded", JSON.stringify([a.run.error, a.run.tables.map((t) => t.error)]));
    const r = await q("moveit_dst", "INSERT INTO things (name) VALUES ('new') RETURNING id, name");
    assert.equal(Number(r[0].id), 31);
    const b = await planRun(app, { source: "pgsrc", target: "lite2", tables: ["customers"] });
    assert.equal(b.run.status, "succeeded", JSON.stringify([b.run.error, b.run.tables.map((t) => t.error)]));
    const out = new DatabaseSync(join(dir, "dst.db"));
    out.exec("INSERT INTO customers (email) VALUES ('z@z')");
    assert.equal((out.prepare("SELECT id FROM customers WHERE email = 'z@z'").get() as any).id, 251);
    out.close();
  } finally {
    await conns.closeAll();
  }
});
