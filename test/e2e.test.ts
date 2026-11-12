import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Connections, scrub, type MoveitConfig } from "../src/config.js";
import { verifyEvidence } from "../src/evidence.js";
import { Moveit } from "../src/service.js";
import { Store } from "../src/store.js";

function setup(seed: (src: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), "moveit-"));
  const src = new DatabaseSync(join(dir, "src.db"));
  seed(src);
  src.close();
  const config: MoveitConfig = {
    connections: {
      src: { type: "sqlite", path: join(dir, "src.db"), readOnly: false },
      tgt: { type: "sqlite", path: join(dir, "tgt.db") },
      out: { type: "csv", path: join(dir, "out") },
      back: { type: "sqlite", path: join(dir, "back.db") },
    },
  };
  const conns = new Connections(config);
  const app = new Moveit(config, conns, new Store(join(dir, ".moveit")));
  return { dir, app, conns, config, tables: (name: string, db = "tgt.db") => new DatabaseSync(join(dir, db)).prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name) };
}

const seedOrders = (n: number) => (db: DatabaseSync) => {
  db.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY, customer_email VARCHAR(100) NOT NULL, amount DECIMAL(12,2), placed TIMESTAMP,
    paid BOOLEAN, note TEXT, payload JSON, blob BLOB)`);
  const ins = db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= n; i++)
    ins.run(i, `buyer${i}@example.com`, (i * 1.37).toFixed(2), `2026-01-${String((i % 28) + 1).padStart(2, "0")} 10:00:00`, i % 2, i % 4 === 0 ? "" : i % 5 === 0 ? null : `note ${i}`, `{"n":${i},"a":[1,2]}`, Buffer.from([i % 256, 255, 0]));
  db.exec("CREATE TABLE empty_table (id INTEGER PRIMARY KEY, v TEXT)");
  db.exec("CREATE TABLE tags (order_id INTEGER, tag TEXT)");
  db.exec("INSERT INTO tags VALUES (1,'x'),(1,'y'),(2,'x')");
};

async function planAndDry(app: Moveit, opts: Parameters<Moveit["plan"]>[0]) {
  const { plan } = await app.plan(opts);
  const dr = await app.dryRun(plan.id);
  return { plan, dr };
}

test("happy path: plan, dry run, run, verify, reconcile, report", async () => {
  const t = setup(seedOrders(300));
  const { plan, dr } = await planAndDry(t.app, { source: "src", target: "tgt" });
  assert.equal(plan.tables.length, 3); // includes an empty table
  assert.ok(dr.ok && dr.complete);
  const run = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 64 });
  assert.equal(run.status, "succeeded", JSON.stringify(run.tables.map((x) => x.error)));
  assert.deepEqual(t.tables("x"), ["empty_table", "orders", "tags"]);
  assert.ok(run.tables.every((x) => x.status === "promoted" && x.verify?.ok));
  const rec = await t.app.reconcile(plan.id);
  assert.ok(rec.ok);
  const out = new DatabaseSync(join(t.dir, "tgt.db"));
  assert.equal((out.prepare("SELECT COUNT(*) c FROM orders").get() as any).c, 300);
  // NULL stays NULL and '' stays '' on a target that can tell them apart
  assert.equal((out.prepare("SELECT COUNT(*) c FROM orders WHERE note IS NULL").get() as any).c, 45); // multiples of 5 that are not multiples of 4
  assert.equal((out.prepare("SELECT COUNT(*) c FROM orders WHERE note = ''").get() as any).c, 75);
  const report = t.app.report(run.id);
  assert.ok(report.evidenceOk);
  assert.match(report.markdown, /Chain intact:\*\* yes/);
  assert.equal(readdirSync(join(t.dir, ".moveit", "runs", run.id)).includes("report.md"), true);
  await t.conns.closeAll();
});

test("run is refused without a passing, complete dry run for this exact plan", async () => {
  const t = setup(seedOrders(20));
  const { plan } = await t.app.plan({ source: "src", target: "tgt" });
  await assert.rejects(t.app.run(plan.id, { planHash: plan.hash }), /not been dry-run/);
  await t.app.dryRun(plan.id, { maxRows: 5 });
  await assert.rejects(t.app.run(plan.id, { planHash: plan.hash }), /partial/);
  await t.app.dryRun(plan.id);
  await assert.rejects(t.app.run(plan.id, { planHash: "deadbeef" }), /planHash does not match/);
  const rec = t.app.getPlan(plan.id);
  rec.plan.tables[0].targetTable = "tampered";
  t.app.store.savePlan(rec);
  await assert.rejects(t.app.run(plan.id, { planHash: plan.hash }), /modified/);
  assert.deepEqual(t.tables("x"), []); // nothing was ever created
  await t.conns.closeAll();
});

test("dry run finds rows that cannot migrate and blocks the run", async () => {
  const t = setup((db) => {
    db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, code VARCHAR(5), age SMALLINT, born DATE)");
    const ins = db.prepare("INSERT INTO people VALUES (?,?,?,?)");
    ins.run(1, "ok", 30, "1990-01-01");
    ins.run(2, "toolong", 30, "1990-01-01"); // SQLite does not enforce VARCHAR(5)
    ins.run(3, "ok", 99999999999, "1990-01-01"); // SMALLINT maps to a 32-bit target
    ins.run(4, "ok", 30, "1990-02-30"); // impossible date
    ins.run(5, "ok", 30, "not a date");
  });
  const { plan, dr } = await planAndDry(t.app, { source: "src", target: "tgt" });
  assert.equal(dr.ok, false);
  const failures = dr.tables[0].failures.map((f) => `${f.column}:${f.code}:${f.count}`).sort();
  assert.ok(failures.includes("code:too_long:1"), failures.join());
  assert.ok(failures.includes("age:int_range:1"));
  assert.ok(failures.includes("born:bad_date:2"));
  const ex = dr.tables[0].failures.find((f) => f.code === "too_long")!.examples[0];
  assert.equal(ex.row, "id=2"); // names the row, not the value
  assert.equal(ex.value, undefined);
  await assert.rejects(t.app.run(plan.id, { planHash: plan.hash }), /cannot be migrated/);
  // a type override makes the same data pass
  const fixed = await planAndDry(t.app, {
    source: "src",
    target: "tgt",
    overrides: [{ source: "people", typeOverrides: { code: { type: "string", length: 20 }, age: { type: "bigint" }, born: { type: "string", length: 20 } } }],
  });
  assert.ok(fixed.dr.ok);
  await t.conns.closeAll();
});

test("plan reports conflicts: existing target, collisions, unknown columns", async () => {
  const t = setup(seedOrders(5));
  const first = await planAndDry(t.app, { source: "src", target: "tgt" });
  await t.app.run(first.plan.id, { planHash: first.plan.hash });
  const again = await t.app.plan({ source: "src", target: "tgt" });
  assert.ok(again.plan.issues.some((i) => i.code === "target_exists"));
  const bad = await t.app.plan({
    source: "src",
    target: "out",
    tables: ["orders"],
    overrides: [{ source: "orders", renames: { note: "paid", nope: "x" }, exclude: ["ghost"] }],
  });
  const codes = bad.plan.issues.map((i) => i.code);
  assert.ok(codes.includes("column_collision"));
  assert.equal(codes.filter((c) => c === "unknown_column").length, 2);
  await assert.rejects(t.app.run(bad.plan.id, { planHash: bad.plan.hash }), /not been dry-run|error/);
  await assert.rejects(t.app.plan({ source: "src", target: "tgt", tables: ["missing"] }), /not found in source/);
  await t.conns.closeAll();
});

test("corrupted load is caught by verification: nothing promoted, staging rollback works", async () => {
  const t = setup(seedOrders(100));
  const { plan } = await planAndDry(t.app, { source: "src", target: "tgt", tables: ["orders"] });
  const tgt: any = await t.conns.get("tgt");
  const real = tgt.insertRows.bind(tgt);
  let calls = 0;
  tgt.insertRows = async (table: any, cols: string[], rows: unknown[][]) => {
    if (++calls === 2) rows = rows.map((r, i) => (i === 3 ? r.map((v) => (typeof v === "string" && v.startsWith("note") ? v + "!" : v)) : r)); // silently alter one value
    return real(table, cols, rows);
  };
  const run = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 30 });
  assert.equal(run.status, "failed");
  assert.match(run.tables[0].error!, /Verification failed .*mismatched columns \[note\]/s);
  assert.deepEqual(t.tables("x"), [run.tables[0].stagingTable]); // only staging exists, final table never appeared
  assert.ok(!t.tables("x").includes("orders"));
  await assert.rejects(t.app.rollback(run.id, "wrong"), /confirm/);
  await t.app.rollback(run.id, run.id);
  assert.deepEqual(t.tables("x"), []);
  assert.ok(verifyEvidence(t.app.store.evidenceFile(run.id)).ok);
  await t.conns.closeAll();
});

test("source changing mid-copy is detected", async () => {
  const t = setup(seedOrders(60));
  const { plan } = await planAndDry(t.app, { source: "src", target: "tgt", tables: ["orders"] });
  const src: any = await t.conns.get("src");
  const real = src.readRows.bind(src);
  src.readRows = async function* (table: string, opts: any) {
    let first = true;
    for await (const b of real(table, opts)) {
      yield b;
      if (first) {
        first = false;
        const w = new DatabaseSync(join(t.dir, "src.db"));
        w.exec("INSERT INTO orders (id, customer_email, amount) VALUES (9999, 'late@example.com', '1.00')");
        w.close();
      }
    }
  };
  const run = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 20 });
  assert.equal(run.status, "failed");
  assert.match(run.tables[0].error!, /Row count unstable|source changed/i);
  assert.ok(!t.tables("x").includes("orders"));
  await t.conns.closeAll();
});

test("run can pause and resume without losing or duplicating rows", async () => {
  const t = setup(seedOrders(95));
  const { plan } = await planAndDry(t.app, { source: "src", target: "tgt", tables: ["orders"] });
  const part = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 10, maxBatches: 3 });
  assert.equal(part.status, "partial");
  assert.equal(part.tables[0].rowsLoaded, 30);
  assert.deepEqual(t.tables("x"), [part.tables[0].stagingTable]);
  const done = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 10, resumeRunId: part.id });
  assert.equal(done.status, "succeeded", done.tables[0].error);
  assert.equal(done.tables[0].rowsLoaded, 95);
  assert.equal((new DatabaseSync(join(t.dir, "tgt.db")).prepare("SELECT COUNT(*) c FROM orders").get() as any).c, 95);
  assert.ok((await t.app.reconcile(plan.id)).ok);
  await assert.rejects(t.app.run(plan.id, { planHash: plan.hash, resumeRunId: done.id }), /already succeeded/);
  await t.conns.closeAll();
});

test("round trip SQLite -> CSV -> SQLite keeps every value, including NULL vs empty string", async () => {
  const t = setup(seedOrders(120));
  const a = await planAndDry(t.app, { source: "src", target: "out", tables: ["orders"] });
  const r1 = await t.app.run(a.plan.id, { planHash: a.plan.hash, batchSize: 50 });
  assert.equal(r1.status, "succeeded", r1.tables[0].error);
  assert.ok(existsSync(join(t.dir, "out", "orders.csv")));
  const csv = readFileSync(join(t.dir, "out", "orders.csv"), "utf8");
  assert.match(csv, /,""(,|\n)/); // empty string is written quoted so it differs from NULL
  const b = await planAndDry(t.app, {
    source: "out",
    target: "back",
    // a CSV carries no types: say which column is binary and which is the key
    overrides: [{ source: "orders", primaryKey: ["id"], typeOverrides: { blob: { type: "binary" } } }],
  });
  assert.ok(b.dr.ok, JSON.stringify(b.dr.tables));
  const r2 = await t.app.run(b.plan.id, { planHash: b.plan.hash });
  assert.equal(r2.status, "succeeded", r2.tables[0].error);
  const q = (db: string) => {
    const d = new DatabaseSync(join(t.dir, db));
    d.exec("PRAGMA foreign_keys=off");
    return d;
  };
  const orig = q("src.db").prepare("SELECT id, customer_email, CAST(amount AS TEXT) a, paid, note, hex(blob) h FROM orders ORDER BY id").all();
  const back = q("back.db").prepare("SELECT id, customer_email, CAST(amount AS TEXT) a, paid, note, hex(blob) h FROM orders ORDER BY id").all();
  assert.equal(back.length, orig.length);
  for (let i = 0; i < orig.length; i++) {
    const o: any = orig[i];
    const x: any = back[i];
    assert.equal(x.note, o.note, `note row ${o.id}`);
    assert.equal(x.h, o.h, `blob row ${o.id}`);
    assert.equal(Number(x.a), Number(o.a), `amount row ${o.id}`);
    assert.equal(Boolean(x.paid), Boolean(o.paid));
  }
  await t.conns.closeAll();
});

test("evidence log detects tampering", async () => {
  const t = setup(seedOrders(10));
  const { plan } = await planAndDry(t.app, { source: "src", target: "tgt", tables: ["orders"] });
  const run = await t.app.run(plan.id, { planHash: plan.hash });
  const file = t.app.store.evidenceFile(run.id);
  assert.ok(verifyEvidence(file).ok);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const e = JSON.parse(lines[3]);
  e.data.rows = 999999; // rewrite history
  lines[3] = JSON.stringify(e);
  writeFileSync(file, lines.join("\n") + "\n");
  const v = verifyEvidence(file);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 4);
  assert.match(t.app.report(run.id).markdown, /Chain intact:\*\* NO/);
  // deleting a line is caught too
  writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
  assert.equal(verifyEvidence(file).ok, false);
  await t.conns.closeAll();
});

test("rollback drops what the run created and nothing else", async () => {
  const t = setup(seedOrders(10));
  new DatabaseSync(join(t.dir, "tgt.db")).exec("CREATE TABLE precious (x INTEGER); INSERT INTO precious VALUES (42)");
  const { plan } = await planAndDry(t.app, { source: "src", target: "tgt" });
  const run = await t.app.run(plan.id, { planHash: plan.hash });
  assert.deepEqual(t.tables("x"), ["empty_table", "orders", "precious", "tags"]);
  await t.app.rollback(run.id, run.id);
  assert.deepEqual(t.tables("x"), ["precious"]);
  assert.equal((new DatabaseSync(join(t.dir, "tgt.db")).prepare("SELECT x FROM precious").get() as any).x, 42);
  assert.equal(t.app.runStatus(run.id).status, "rolled_back");
  assert.equal(t.tables("x", "src.db").length, 3); // source untouched
  await t.conns.closeAll();
});

test("agent-facing output is redacted by default", async () => {
  const t = setup(seedOrders(5));
  const s = await t.app.sampleRows("src", "orders", 2);
  const row: any = s.rows[0];
  assert.equal(row.customer_email, "[redacted]");
  assert.equal(row.blob, "<binary 3 bytes>");
  const raw = await t.app.sampleRows("src", "orders", 1, false);
  assert.match(String((raw.rows[0] as any).customer_email), /@example\.com$/);
  const p = await t.app.profile("src", "orders");
  assert.equal(p.columns.find((c) => c.name === "id")!.looksUnique, true);
  assert.equal(p.rowsSampled, 5);
  await t.conns.closeAll();
});

test("secrets never appear in error text", () => {
  process.env.TEST_DB_PASSWORD = "hunter2-very-secret";
  const config: MoveitConfig = { connections: { pg: { type: "postgres", host: "h", password: "${TEST_DB_PASSWORD}", database: "d" } } };
  assert.equal(scrub("connect failed for password hunter2-very-secret on host h", config), "connect failed for password [redacted] on host h");
  assert.equal(scrub("postgres://admin:s3cr3t@db:5432/x", undefined), "postgres://admin:[redacted]@db:5432/x");
  assert.equal(scrub("token=abc123&x=1", undefined), "token=[redacted]&x=1");
  assert.deepEqual(new Moveit(config, new Connections(config), new Store(mkdtempSync(join(tmpdir(), "m-")))).listConnections(), [{ name: "pg", type: "postgres", readOnly: false }]);
});

test("a failed run's leftover staging blocks a new run with a clear message, and rollback clears it", async () => {
  const t = setup(seedOrders(40));
  const { plan } = await planAndDry(t.app, { source: "src", target: "tgt", tables: ["orders"] });
  const part = await t.app.run(plan.id, { planHash: plan.hash, batchSize: 10, maxBatches: 1 });
  assert.equal(part.status, "partial");
  await assert.rejects(t.app.run(plan.id, { planHash: plan.hash }), /Leftover table .*resumeRunId/);
  await t.app.rollback(part.id, part.id);
  const again = await t.app.run(plan.id, { planHash: plan.hash });
  assert.equal(again.status, "succeeded");
  await t.conns.closeAll();
});

test("targets that do not enforce primary keys still reject duplicates, after staging", async () => {
  const t = setup((db) => {
    db.exec("CREATE TABLE items (k INTEGER, v TEXT)");
    db.exec("INSERT INTO items VALUES (1,'a'),(2,'b'),(3,'c')");
  });
  const { plan, dr } = await planAndDry(t.app, { source: "src", target: "tgt", overrides: [{ source: "items", primaryKey: ["k"] }] });
  assert.ok(dr.ok); // unique at dry-run time
  new DatabaseSync(join(t.dir, "src.db")).exec("INSERT INTO items VALUES (2,'dup')"); // a duplicate appears before the run
  // simulate Snowflake/Databricks: the PK is declared but the database will not enforce it
  const tgt: any = await t.conns.get("tgt");
  tgt.enforcesPrimaryKey = false;
  const create = tgt.createTable.bind(tgt);
  tgt.createTable = (info: any, opts: any) => create(info, { ...opts, withPrimaryKey: false });
  const run = await t.app.run(plan.id, { planHash: plan.hash });
  assert.equal(run.status, "failed");
  assert.match(run.tables[0].error!, /1 duplicate primary-key value\(s\)/);
  assert.ok(!t.tables("x").includes("items")); // never promoted
  await t.conns.closeAll();
});
