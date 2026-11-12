import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Connections, type MoveitConfig } from "../src/config.js";
import { prefetch } from "../src/runner.js";
import { Moveit } from "../src/service.js";
import { Store } from "../src/store.js";

function setup(seed: (src: DatabaseSync) => void, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "moveit-lim-"));
  const src = new DatabaseSync(join(dir, "src.db"));
  seed(src);
  src.close();
  const config: MoveitConfig = {
    connections: {
      src: { type: "sqlite", path: join(dir, "src.db"), ...extra },
      tgt: { type: "sqlite", path: join(dir, "tgt.db") },
      out: { type: "csv", path: join(dir, "out") },
    },
  };
  const conns = new Connections(config);
  const app = new Moveit(config, conns, new Store(join(dir, ".moveit")));
  const open = (f = "tgt.db") => new DatabaseSync(join(dir, f));
  return { dir, app, conns, config, open };
}

const seedItems = (n: number) => (db: DatabaseSync) => {
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, qty INTEGER)");
  const ins = db.prepare("INSERT INTO items VALUES (?,?,?)");
  for (let i = 1; i <= n; i++) ins.run(i, `item ${i}`, i * 2);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get() as any).c as number;

async function planRun(app: Moveit, opts: Parameters<Moveit["plan"]>[0], run: Partial<Parameters<Moveit["run"]>[1]> = {}) {
  const { plan } = await app.plan(opts);
  assert.ok(!plan.issues.some((i) => i.severity === "error"), JSON.stringify(plan.issues.filter((i) => i.severity === "error")));
  const dr = await app.dryRun(plan.id);
  assert.ok(dr.ok, JSON.stringify(dr));
  const r = await app.run(plan.id, { planHash: plan.hash, ...run });
  return { plan, run: r };
}

// ---------------------------------------------------------------- 1. resume after a crash

test("resume: rows that landed without a checkpoint are detected and the table restarts, so nothing is duplicated", async () => {
  const t = setup(seedItems(40));
  const { plan } = await t.app.plan({ source: "src", target: "tgt" });
  await t.app.dryRun(plan.id);
  const part = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 10, maxBatches: 1 });
  assert.equal(part.status, "partial");
  // simulate a crash between a batch landing and its checkpoint: rows 11-20 are in staging, the checkpoint stops at 10
  const db = t.open();
  const staging = part.tables[0].stagingTable;
  for (let i = 11; i <= 20; i++) db.prepare(`INSERT INTO "${staging}" (id, name, qty) VALUES (?, 'stray', 0)`).run(i);
  db.close();
  const done = await t.app.run(plan.id, { planHash: plan.hash, resumeRunId: part.id, batchSize: 10 });
  assert.equal(done.status, "succeeded", JSON.stringify(done.tables.map((x) => x.error)));
  assert.ok(done.warnings.some((w) => /restarted this table/.test(w)));
  const out = t.open();
  assert.equal(count(out, "items"), 40);
  assert.equal((out.prepare("SELECT COUNT(*) c FROM items WHERE name = 'stray'").get() as any).c, 0);
  assert.ok((await t.app.reconcile(plan.id)).ok);
  await t.conns.closeAll();
});

test("resume: a clean pause continues where it stopped, without restarting", async () => {
  const t = setup(seedItems(40));
  const { plan } = await t.app.plan({ source: "src", target: "tgt" });
  await t.app.dryRun(plan.id);
  const part = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 10, maxBatches: 2 });
  assert.equal(part.tables[0].rowsLoaded, 20);
  const done = await t.app.run(plan.id, { planHash: plan.hash, resumeRunId: part.id, batchSize: 10 });
  assert.equal(done.status, "succeeded");
  assert.ok(!done.warnings.some((w) => /restarted/.test(w)));
  assert.equal(count(t.open(), "items"), 40);
  await t.conns.closeAll();
});

// ---------------------------------------------------------------- 2. snapshot consistency

test("snapshot: a writer changing the source mid-copy no longer breaks the run, and reconcile shows the drift afterwards", async () => {
  const t = setup((db) => {
    db.exec("PRAGMA journal_mode = WAL");
    seedItems(60)(db);
  }, { snapshot: true });
  const { plan } = await t.app.plan({ source: "src", target: "tgt" });
  await t.app.dryRun(plan.id);
  const tgt: any = await t.conns.get("tgt");
  const orig = tgt.insertRows.bind(tgt);
  let wrote = false;
  tgt.insertRows = async (...a: unknown[]) => {
    await orig(...a);
    if (!wrote) {
      wrote = true;
      const w = new DatabaseSync(join(t.dir, "src.db")); // a second connection writes while the copy is in flight
      w.exec("INSERT INTO items VALUES (1000, 'late arrival', 1); UPDATE items SET qty = 999 WHERE id = 5");
      w.close();
    }
  };
  const run = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 20 });
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)));
  assert.equal(run.snapshot, "consistent");
  const out = t.open();
  assert.equal(count(out, "items"), 60);
  assert.equal((out.prepare("SELECT qty FROM items WHERE id = 5").get() as any).qty, 10); // the value at the snapshot, not the update
  assert.ok(run.warnings.some((w) => /61 rows now/.test(w)));
  assert.equal((await t.app.reconcile(plan.id)).ok, false);
  await t.conns.closeAll();
});

test("without a snapshot the same mid-copy write still fails the run safely", async () => {
  const t = setup((db) => {
    db.exec("PRAGMA journal_mode = WAL");
    seedItems(60)(db);
  });
  const { plan } = await t.app.plan({ source: "src", target: "tgt" });
  await t.app.dryRun(plan.id);
  const tgt: any = await t.conns.get("tgt");
  const orig = tgt.insertRows.bind(tgt);
  let wrote = false;
  tgt.insertRows = async (...a: unknown[]) => {
    await orig(...a);
    if (!wrote) {
      wrote = true;
      const w = new DatabaseSync(join(t.dir, "src.db"));
      w.exec("INSERT INTO items VALUES (1000, 'late arrival', 1)");
      w.close();
    }
  };
  const run = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 20 });
  assert.equal(run.status, "failed");
  assert.equal(run.snapshot, "none");
  assert.match(run.tables[0].error ?? "", /Row count unstable/);
  assert.equal(t.open().prepare("SELECT name FROM sqlite_master WHERE name = 'items'").all().length, 0); // nothing promoted
  await t.conns.closeAll();
});

// ---------------------------------------------------------------- 3. pipelining

test("pipelining: the next batch is read while the previous one is being written", async () => {
  const run = async (depth: number) => {
    const t = setup(seedItems(50));
    const { plan } = await t.app.plan({ source: "src", target: "tgt" });
    await t.app.dryRun(plan.id);
    const src: any = await t.conns.get("src");
    const tgt: any = await t.conns.get("tgt");
    const events: string[] = [];
    const origRead = src.readRows.bind(src);
    src.readRows = async function* (...a: unknown[]) {
      let i = 0;
      for await (const b of origRead(...a)) {
        await sleep(30);
        events.push(`read${++i}`);
        yield b;
      }
    };
    const origWrite = tgt.insertRows.bind(tgt);
    let w = 0;
    tgt.insertRows = async (...a: unknown[]) => {
      const n = ++w;
      events.push(`write${n}:start`);
      await sleep(90);
      await origWrite(...a);
      events.push(`write${n}:end`);
    };
    const started = Date.now();
    const r = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 10, prefetch: depth });
    const ms = Date.now() - started;
    assert.equal(r.status, "succeeded");
    assert.equal(count(t.open(), "items"), 50);
    await t.conns.closeAll();
    return { events, ms };
  };
  const piped = await run(2);
  assert.ok(piped.events.indexOf("read2") < piped.events.indexOf("write1:end"), piped.events.join(" "));
  const serial = await run(0);
  assert.ok(serial.events.indexOf("read2") > serial.events.indexOf("write1:end"), serial.events.join(" "));
  assert.ok(piped.ms < serial.ms, `pipelined ${piped.ms}ms vs serial ${serial.ms}ms`);
});

test("prefetch helper: order is preserved, errors surface, and the source is closed on early exit", async () => {
  async function* gen(n: number, failAt?: number, onClose?: () => void) {
    try {
      for (let i = 1; i <= n; i++) {
        if (i === failAt) throw new Error("boom");
        yield i;
      }
    } finally {
      onClose?.();
    }
  }
  const all: number[] = [];
  for await (const x of prefetch(gen(7), 3)) all.push(x);
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7]);
  const some: number[] = [];
  await assert.rejects(async () => {
    for await (const x of prefetch(gen(7, 4), 2)) some.push(x);
  }, /boom/);
  assert.deepEqual(some, [1, 2, 3]);
  let closed = false;
  for await (const x of prefetch(gen(100, undefined, () => (closed = true)), 2)) if (x === 2) break;
  assert.ok(closed);
  assert.deepEqual(await (async () => { const o: number[] = []; for await (const x of prefetch(gen(3), 0)) o.push(x); return o; })(), [1, 2, 3]);
});

// ---------------------------------------------------------------- 4. replace and append

test("replace: the old table is kept as a backup, rollback restores it, finalize drops it for good", async () => {
  const t = setup(seedItems(30));
  const pre = t.open();
  pre.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, qty INTEGER); INSERT INTO items VALUES (1, 'OLD', 0), (2, 'OLD', 0)");
  pre.close();

  // create mode refuses and says what to do instead
  const { plan: c } = await t.app.plan({ source: "src", target: "tgt" });
  assert.ok(c.issues.some((i) => i.code === "target_exists" && /replace/.test(i.message)));

  const { plan, run } = await planRun(t.app, { source: "src", target: "tgt", mode: "replace" });
  assert.equal(plan.mode, "replace");
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)));
  const bak = run.tables[0].backupTable!;
  assert.match(bak, /_bak_items$/);
  let db = t.open();
  assert.equal(count(db, "items"), 30);
  assert.equal(count(db, bak), 2); // the old data is intact next to the new
  assert.ok(run.warnings.some((w) => /finalize_run/.test(w)));
  db.close();

  const back = await t.app.rollback(run.id, run.id);
  assert.equal(back.status, "rolled_back");
  db = t.open();
  assert.equal(count(db, "items"), 2);
  assert.equal((db.prepare("SELECT name FROM items WHERE id = 1").get() as any).name, "OLD");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_moveit_%'").all().length, 0);
  db.close();

  // second go, this time finalized
  const again = await planRun(t.app, { source: "src", target: "tgt", mode: "replace" });
  assert.equal(again.run.status, "succeeded");
  await assert.rejects(t.app.finalize(again.run.id, "nope"), /confirm/);
  const fin = await t.app.finalize(again.run.id, again.run.id);
  assert.equal(fin.finalized, true);
  db = t.open();
  assert.equal(count(db, "items"), 30);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_moveit_%'").all().length, 0);
  db.close();
  await assert.rejects(t.app.rollback(again.run.id, again.run.id), /finalized/);
  await t.conns.closeAll();
});

test("replace with nothing there yet behaves like create", async () => {
  const t = setup(seedItems(12));
  const { run } = await planRun(t.app, { source: "src", target: "tgt", mode: "replace" });
  assert.equal(run.status, "succeeded");
  assert.equal(run.tables[0].backupTable, undefined);
  assert.equal(count(t.open(), "items"), 12);
  await t.conns.closeAll();
});

test("replace is refused when other tables have foreign keys into the table", async () => {
  const t = setup(seedItems(5));
  const pre = t.open();
  pre.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, qty INTEGER); CREATE TABLE refs (id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id))");
  pre.close();
  const { plan } = await t.app.plan({ source: "src", target: "tgt", mode: "replace" });
  assert.ok(plan.issues.some((i) => i.code === "replace_referenced" && i.severity === "error" && /refs/.test(i.message)));
  await t.conns.closeAll();
});

test("append: rows are added after a key check, verified, and removed again by rollback", async () => {
  const t = setup(seedItems(20));
  const pre = t.open();
  pre.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, qty INTEGER); INSERT INTO items VALUES (1001, 'existing', 1), (1002, 'existing', 2)");
  pre.close();
  const { plan, run } = await planRun(t.app, { source: "src", target: "tgt", mode: "append" });
  assert.deepEqual(plan.tables[0].appendKey, ["id"]);
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)));
  let db = t.open();
  assert.equal(count(db, "items"), 22);
  assert.equal(run.tables[0].targetCountBefore, 2);
  assert.ok(run.warnings.some((w) => /finalize_run/.test(w)));
  db.close();

  const back = await t.app.rollback(run.id, run.id);
  assert.equal(back.status, "rolled_back");
  db = t.open();
  assert.equal(count(db, "items"), 2); // exactly the rows that were there before
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_moveit_%'").all().length, 0);
  db.close();
  await t.conns.closeAll();
});

test("append: a key collision stops the run before anything is written", async () => {
  const t = setup(seedItems(20));
  const pre = t.open();
  pre.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, qty INTEGER); INSERT INTO items VALUES (3, 'clash', 1), (1002, 'fine', 2)");
  pre.close();
  const { plan } = await t.app.plan({ source: "src", target: "tgt", mode: "append" });
  await t.app.dryRun(plan.id);
  const run = await t.app.run(plan.id, { planHash: plan.hash });
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /1 row\(s\) of items have keys that already exist/);
  assert.match(t.app.report(run.id).markdown, /have keys that already exist/);
  assert.equal(count(t.open(), "items"), 2);
  await t.app.rollback(run.id, run.id);
  assert.equal(t.open().prepare("SELECT name FROM sqlite_master WHERE name LIKE '_moveit_%'").all().length, 0);
  await t.conns.closeAll();
});

test("append into an empty table is verified against the whole table", async () => {
  const t = setup(seedItems(15));
  const pre = t.open();
  pre.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, qty INTEGER)");
  pre.close();
  const { run } = await planRun(t.app, { source: "src", target: "tgt", mode: "append" });
  assert.equal(run.status, "succeeded");
  assert.equal(count(t.open(), "items"), 15);
  await t.conns.closeAll();
});

test("append plan checks the existing table: missing table, missing column, unfilled NOT NULL column", async () => {
  const t = setup(seedItems(5));
  let { plan } = await t.app.plan({ source: "src", target: "tgt", mode: "append" });
  assert.ok(plan.issues.some((i) => i.code === "target_missing"));
  const pre = t.open();
  pre.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR(50) NOT NULL, extra TEXT NOT NULL)");
  pre.close();
  ({ plan } = await t.app.plan({ source: "src", target: "tgt", mode: "append" }));
  assert.ok(plan.issues.some((i) => i.code === "append_missing_column" && i.column === "qty"));
  assert.ok(plan.issues.some((i) => i.code === "append_unfilled_column" && i.column === "extra"));
  await t.conns.closeAll();
});

test("append is not offered for CSV targets", async () => {
  const t = setup(seedItems(3));
  const { plan } = await t.app.plan({ source: "src", target: "out", mode: "append" });
  assert.ok(plan.issues.some((i) => i.code === "mode_unsupported" && i.severity === "error"));
  await t.conns.closeAll();
});

// ---------------------------------------------------------------- 5. identity, defaults, indexes, foreign keys, inventory

const seedSchemaObjects = (db: DatabaseSync) => {
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email VARCHAR(80) NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'new',
      score INTEGER DEFAULT 5,
      created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX ux_customers_email ON customers (email);
    CREATE INDEX idx_customers_status ON customers (status, score);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      total DECIMAL(10,2)
    );
    CREATE INDEX idx_orders_customer ON orders (customer_id);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
    CREATE TRIGGER trg_orders AFTER INSERT ON orders BEGIN SELECT 1; END;
  `);
  for (let i = 1; i <= 25; i++) db.prepare("INSERT INTO customers (email, status, score) VALUES (?, ?, ?)").run(`c${i}@x.io`, i % 2 ? "new" : "vip", i);
  db.exec("DELETE FROM customers WHERE id > 25"); // keep it tidy
  for (let i = 1; i <= 40; i++) db.prepare("INSERT INTO orders VALUES (?, ?, ?)").run(i, (i % 25) + 1, (i * 7.5).toFixed(2));
};

test("schema objects: identity, defaults, indexes and foreign keys come across; views and triggers are listed, not migrated", async () => {
  const t = setup(seedSchemaObjects);
  const { plan, run } = await planRun(t.app, { source: "src", target: "tgt" });
  const cust = plan.tables.find((x) => x.sourceTable === "customers")!;
  assert.equal(cust.identity?.column, "id");
  assert.deepEqual(cust.indexes.map((i) => i.name).sort(), ["idx_customers_status", "ux_customers_email"]);
  assert.equal(plan.tables.find((x) => x.sourceTable === "orders")!.foreignKeys.length, 1);
  assert.deepEqual(plan.inventory.map((o) => `${o.kind}:${o.name}`).sort(), ["trigger:trg_orders", "view:big_orders"]);
  assert.ok(plan.issues.some((i) => i.code === "unmigrated_objects"));
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)) + JSON.stringify(run.constraintFailures));
  assert.equal(run.constraintFailures.length, 0);

  const db = t.open();
  const idx = (tb: string) => db.prepare(`PRAGMA index_list("${tb}")`).all().map((r: any) => `${r.name}:${r.unique}`).sort();
  assert.deepEqual(idx("customers").filter((x) => !x.startsWith("sqlite_autoindex")), ["idx_customers_status:0", "ux_customers_email:1"]);
  assert.deepEqual(idx("orders").filter((x) => !x.startsWith("sqlite_autoindex")), ["idx_orders_customer:0"]);
  const fk: any[] = db.prepare("PRAGMA foreign_key_list(orders)").all();
  assert.equal(fk.length, 1);
  assert.equal(fk[0].table, "customers");
  assert.equal(fk[0].on_delete, "CASCADE");
  // defaults apply to new rows
  db.exec("INSERT INTO customers (email) VALUES ('new@x.io')");
  const row: any = db.prepare("SELECT * FROM customers WHERE email = 'new@x.io'").get();
  assert.equal(row.status, "new");
  assert.equal(row.score, 5);
  assert.match(String(row.created), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
  // identity continues after the highest copied key
  assert.equal(row.id, 26);
  // the view and trigger were not created
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('view','trigger')").all().length, 0);
  // the report lists what was carried and what was not
  const md = t.app.report(run.id).markdown;
  assert.match(md, /idx_customers_status/);
  assert.match(md, /Not migrated/);
  assert.match(md, /big_orders/);
  await t.conns.closeAll();
});

test("schema objects can be switched off one by one", async () => {
  const t = setup(seedSchemaObjects);
  const { plan } = await t.app.plan({ source: "src", target: "tgt", objects: { indexes: false, foreignKeys: false, defaults: false, identity: false } });
  for (const tp of plan.tables) {
    assert.equal(tp.indexes.length, 0);
    assert.equal(tp.foreignKeys.length, 0);
    assert.equal(tp.identity, undefined);
    assert.ok(tp.columns.every((c) => c.target.default === undefined));
  }
  await t.conns.closeAll();
});

test("schema objects go to CSV without errors: indexes and keys are skipped with a note", async () => {
  const t = setup(seedSchemaObjects);
  const { plan, run } = await planRun(t.app, { source: "src", target: "out" });
  assert.equal(run.status, "succeeded");
  assert.ok(plan.issues.some((i) => i.code === "indexes_skipped"));
  assert.ok(plan.issues.some((i) => i.code === "fks_skipped"));
  await t.conns.closeAll();
});

test("replace carries indexes over without clashing with the old table's index names", async () => {
  const t = setup(seedSchemaObjects);
  await planRun(t.app, { source: "src", target: "tgt" }); // first copy, with its indexes
  const { run, plan } = await planRun(t.app, { source: "src", target: "tgt", mode: "replace" });
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)));
  assert.equal(run.constraintFailures.length, 0, JSON.stringify(run.constraintFailures));
  const cust = plan.tables.find((x) => x.sourceTable === "customers")!;
  assert.ok(cust.indexes.every((i) => !["idx_customers_status", "ux_customers_email"].includes(i.name)), "names must not collide with the backup's");
  const db = t.open();
  assert.equal(db.prepare(`PRAGMA index_list("customers")`).all().filter((r: any) => !String(r.name).startsWith("sqlite_autoindex")).length, 2);
  await t.app.finalize(run.id, run.id);
  await t.conns.closeAll();
});

test("an index that cannot be built is reported with its statement; the data is still migrated", async () => {
  const t = setup(seedSchemaObjects);
  const tgt: any = await t.conns.get("tgt");
  const orig = tgt.createIndex.bind(tgt);
  tgt.createIndex = async (table: string, ix: { name: string }) => {
    if (ix.name === "idx_customers_status") throw new Error("simulated failure");
    return orig(table, ix);
  };
  const { run } = await planRun(t.app, { source: "src", target: "tgt" });
  assert.equal(run.status, "succeeded");
  assert.equal(run.constraintFailures.length, 1);
  assert.equal(run.constraintFailures[0].name, "idx_customers_status");
  assert.match(run.constraintFailures[0].sql, /CREATE INDEX idx_customers_status ON customers \(status, score\)/);
  assert.match(t.app.report(run.id).markdown, /Constraints to create by hand/);
  await t.conns.closeAll();
});

test("rollback after a create run drops the foreign keys it added first", async () => {
  const t = setup(seedSchemaObjects);
  const { run } = await planRun(t.app, { source: "src", target: "tgt" });
  await t.app.rollback(run.id, run.id);
  assert.deepEqual(t.open().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), []);
  await t.conns.closeAll();
});
