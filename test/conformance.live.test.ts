// Conformance suite: the same scenario run against every system you give it a scratch database for.
//
//   SQLite always runs (it validates the suite itself) and PostgreSQL runs when MOVEIT_TEST_PG is set.
//   For the others, set a variable to a JSON connection config (the same shape as in moveit.config.json,
//   ${ENV} references allowed) pointing at a SCRATCH database or schema; the suite only creates and drops
//   tables whose names start with conf_ (and moveit's own _moveit_ tables for them):
//
//   MOVEIT_TEST_MYSQL='{"type":"mysql","host":"127.0.0.1","user":"root","password":"${MYSQL_PW}","database":"scratch"}'
//   MOVEIT_TEST_ORACLE='{"type":"oracle","user":"scratch","password":"${ORA_PW}","connectString":"localhost/FREEPDB1"}'
//   MOVEIT_TEST_SNOWFLAKE='{"type":"snowflake","account":"...","username":"...","password":"${SF_PW}","warehouse":"...","database":"SCRATCH","schema":"PUBLIC"}'
//   MOVEIT_TEST_DATABRICKS='{"type":"databricks","host":"...","httpPath":"...","token":"${DBX_TOKEN}","catalog":"main","schema":"scratch"}'
//
//   npm run test:live
//
// For each system it checks, in order: SQLite -> system -> SQLite round trip with digests compared at every hop,
// schema objects read back through describeExtras, a snapshot-consistent read with a concurrent writer (where the
// system supports snapshots), identity and defaults on new rows, replace + finalize, and append + rollback.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAdapter } from "../src/adapters/index.js";
import { Connections, type MoveitConfig } from "../src/config.js";
import { Moveit } from "../src/service.js";
import { Store } from "../src/store.js";
import type { Adapter, ConnectionConfig } from "../src/types.js";

const N = 1500;

function seedCustomers(db: DatabaseSync, from: number, count: number) {
  const ins = db.prepare("INSERT INTO conf_customers (id, email, status, score, balance, active, joined, bio, doc, avatar) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = from; i < from + count; i++)
    ins.run(
      i,
      `user${i}@example.com`,
      i % 2 ? "new" : "vip",
      i % 100,
      (i * 1.37).toFixed(2),
      i % 2,
      `2024-03-${String((i % 27) + 1).padStart(2, "0")} 05:06:07`,
      i % 5 === 0 ? null : i % 97 === 0 ? "x".repeat(3000) : `naïve café 日本語 \u{1f600} #${i}`,
      `{"a":${i},"b":[1,2,3]}`,
      Buffer.from([i % 256, 0, 255]),
    );
}

function seedSource(dir: string) {
  const db = new DatabaseSync(join(dir, "src.db"));
  db.exec(`
    CREATE TABLE conf_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email VARCHAR(80) NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'new',
      score INTEGER DEFAULT 5, balance DECIMAL(12,2), active BOOLEAN, joined TIMESTAMP, bio TEXT, doc JSON, avatar BLOB
    );
    CREATE UNIQUE INDEX ux_conf_email ON conf_customers (email);
    CREATE INDEX ix_conf_status ON conf_customers (status, score);
    CREATE TABLE conf_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES conf_customers(id), total DECIMAL(10,2));
    CREATE INDEX ix_conf_orders_c ON conf_orders (customer_id);
    CREATE TABLE conf_empty (id INTEGER PRIMARY KEY, v TEXT);
  `);
  seedCustomers(db, 1, N);
  const o = db.prepare("INSERT INTO conf_orders VALUES (?,?,?)");
  for (let i = 1; i <= 3000; i++) o.run(i, (i % N) + 1, (i * 7.25).toFixed(2));
  db.close();
  // a second source whose rows can be appended to the first one's copy
  const extra = new DatabaseSync(join(dir, "extra.db"));
  extra.exec(`CREATE TABLE conf_customers (
      id INTEGER PRIMARY KEY, email VARCHAR(80) NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'new',
      score INTEGER DEFAULT 5, balance DECIMAL(12,2), active BOOLEAN, joined TIMESTAMP, bio TEXT, doc JSON, avatar BLOB)`);
  seedCustomers(extra, 10001, 10);
  extra.close();
}

async function dropScratch(a: Adapter) {
  let left = (await a.listTables()).filter((t) => /conf_/i.test(t));
  for (let pass = 0; pass < 5 && left.length; pass++) {
    const failed: string[] = [];
    for (const t of left) {
      try {
        await a.dropTable(t);
      } catch {
        failed.push(t); // a foreign key may need another table to go first
      }
    }
    left = failed;
  }
  assert.deepEqual(left, [], "could not clean up scratch tables");
}

interface System {
  label: string;
  cfg: ConnectionConfig;
}

function systems(): System[] {
  const out: System[] = [{ label: "sqlite", cfg: { type: "sqlite", path: join(mkdtempSync(join(tmpdir(), "moveit-conf-")), "target.db") } }];
  if (process.env.MOVEIT_TEST_PG) out.push({ label: "postgres", cfg: { type: "postgres", url: `${process.env.MOVEIT_TEST_PG}/moveit_dst` } });
  for (const [label, v] of [["mysql", "MOVEIT_TEST_MYSQL"], ["oracle", "MOVEIT_TEST_ORACLE"], ["snowflake", "MOVEIT_TEST_SNOWFLAKE"], ["databricks", "MOVEIT_TEST_DATABRICKS"]] as const) {
    const raw = process.env[v];
    if (raw) out.push({ label, cfg: JSON.parse(raw) });
  }
  return out;
}

async function dropAll(sys: System) {
  const a = createAdapter({ ...sys.cfg });
  await a.connect();
  try {
    await dropScratch(a);
  } finally {
    await a.close();
  }
}

for (const sys of systems()) {
  test(`conformance[${sys.label}]`, { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "moveit-conf-run-"));
    seedSource(dir);
    if (sys.label === "postgres") await (async () => { const pg = await import("pg"); const c = new pg.default.Client({ connectionString: (sys.cfg as any).url }); await c.connect(); await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await c.end(); })();
    await dropAll(sys);
    const config: MoveitConfig = {
      connections: {
        src: { type: "sqlite", path: join(dir, "src.db"), readOnly: true },
        extra: { type: "sqlite", path: join(dir, "extra.db"), readOnly: true },
        x: sys.cfg,
        back: { type: "sqlite", path: join(dir, "back.db") },
        back2: { type: "sqlite", path: join(dir, "back2.db") },
      },
    };
    const conns = new Connections(config);
    const app = new Moveit(config, conns, new Store(join(dir, ".moveit")));
    // the SQL helpers (quote, qname, query, ...) exist on every SQL adapter; the interface only lists what the engine needs
    const a = (await conns.get("x")) as Adapter & Record<string, any>;
    const T = (n: string) => a.normalizeIdentifier(n);
    const customers = T("conf_customers");
    const orders = T("conf_orders");
    const email = T("email");
    const id = T("id");
    const all = ["conf_customers", "conf_orders", "conf_empty"];
    const ok = async (planOpts: Parameters<Moveit["plan"]>[0], run: Partial<Parameters<Moveit["run"]>[1]> = {}) => {
      const { plan } = await app.plan(planOpts);
      const errs = plan.issues.filter((i) => i.severity === "error");
      assert.equal(errs.length, 0, JSON.stringify(errs));
      const dr = await app.dryRun(plan.id);
      assert.ok(dr.ok, JSON.stringify(dr.tables.map((x) => x.failures)));
      const r = await app.run(plan.id, { planHash: plan.hash, ...run });
      return { plan, run: r };
    };
    const fail = (r: { error?: string; tables: { error?: string }[] }) => JSON.stringify([r.error, r.tables.map((x) => x.error)]);

    try {
      await t.test("SQLite -> system: staged, verified, promoted, constraints created", async () => {
        const { plan, run } = await ok({ source: "src", target: "x", tables: all });
        assert.equal(run.status, "succeeded", fail(run));
        assert.deepEqual(run.constraintFailures, [], "indexes or foreign keys that the system rejected: " + JSON.stringify(run.constraintFailures));
        const rec = await app.reconcile(plan.id);
        assert.ok(rec.ok, JSON.stringify(rec.tables.map((x) => [x.table, x.verify?.ok, x.verify?.mismatchedColumns])));
        assert.equal(await a.countRows(customers), N);
        assert.equal(await a.countRows(orders), 3000);
      });

      await t.test("schema objects read back through describeExtras", async () => {
        const ex = await a.describeExtras(customers);
        if (a.supportsIndexes) {
          const names = ex.indexes.map((i) => i.name.toLowerCase());
          assert.ok(names.includes("ux_conf_email"), names.join());
          assert.ok(names.includes("ix_conf_status"), names.join());
          assert.equal(ex.indexes.find((i) => i.name.toLowerCase() === "ux_conf_email")?.unique, true);
        }
        if (a.supportsIdentity) assert.equal(ex.identity, id, "identity column");
        if (a.supportsDefaults) assert.deepEqual(ex.defaults[T("status")], { kind: "literal", value: "new" });
        if (a.foreignKeyMode !== "none") {
          const fk = (await a.describeExtras(orders)).foreignKeys;
          assert.equal(fk.length, 1);
          assert.equal(fk[0].refTable, customers);
        }
        const inv = await a.listObjects();
        assert.ok(Array.isArray(inv));
      });

      await t.test("system -> SQLite: the round trip matches at every hop", async () => {
        const names = (await a.listTables()).filter((n) => /^conf_/i.test(n));
        assert.equal(names.length, 3);
        const { plan, run } = await ok({ source: "x", target: "back", tables: names, naming: "preserve" });
        assert.equal(run.status, "succeeded", fail(run));
        assert.ok((await app.reconcile(plan.id)).ok);
      });

      const probe = createAdapter({ ...sys.cfg });
      await probe.connect();
      const snapshots = await probe.beginSnapshot();
      await probe.endSnapshot();
      await probe.close();
      if (snapshots) {
        await t.test("snapshot: a concurrent writer does not leak into the copy", async () => {
          const { plan } = await app.plan({ source: "x", target: "back2", tables: [customers], naming: "preserve" });
          await app.dryRun(plan.id);
          const tgt: any = await conns.get("back2");
          const writer = createAdapter({ ...sys.cfg });
          await writer.connect();
          const info = await writer.describeTable(customers);
          const orig = tgt.insertRows.bind(tgt);
          let wrote = false;
          tgt.insertRows = async (...args: unknown[]) => {
            await orig(...args);
            if (!wrote) {
              wrote = true;
              await writer.insertRows(info, [email], [["late.arrival@example.com"]]);
            }
          };
          try {
            const run = await app.run(plan.id, { planHash: plan.hash, batchSize: 200 });
            assert.equal(run.status, "succeeded", fail(run));
            assert.equal(run.snapshot, "consistent");
            assert.equal(run.tables[0].rowsLoaded, N);
            assert.equal(await a.countRows(customers), N + 1);
          } finally {
            await writer.close();
          }
          await (a as any).exec(`DELETE FROM ${a.qname(customers)} WHERE ${a.quote(email)} = 'late.arrival@example.com'`);
          if (a.kind === "oracle") await a.commit(); // Oracle runs inside an implicit transaction; the others autocommit
        });
      }

      await t.test("identity and defaults work on rows inserted after the migration", async () => {
        const info = await a.describeTable(customers);
        await a.insertRows(info, [email], [["fresh@example.com"]]);
        const row = (await (a as any).query(`SELECT ${a.quote(id)}, ${a.quote(T("status"))} FROM ${a.qname(customers)} WHERE ${a.quote(email)} = ${a.placeholder(1)}`, ["fresh@example.com"]))[0];
        assert.ok(BigInt(String(row[0])) > BigInt(N), `identity gave ${row[0]}`);
        if (a.supportsDefaults) assert.equal(row[1], "new");
        await (a as any).exec(`DELETE FROM ${a.qname(customers)} WHERE ${a.quote(email)} = 'fresh@example.com'`);
        if (a.kind === "oracle") await a.commit(); // Oracle runs inside an implicit transaction; the others autocommit
      });

      await t.test("replace keeps a backup, then finalize drops it", async () => {
        const { run } = await ok({ source: "src", target: "x", tables: all, mode: "replace" });
        assert.equal(run.status, "succeeded", fail(run));
        assert.deepEqual(run.constraintFailures, [], JSON.stringify(run.constraintFailures));
        assert.ok(run.tables.every((x) => x.backupTable));
        assert.equal(await a.countRows(customers), N);
        const fin = await app.finalize(run.id, run.id);
        assert.equal(fin.finalized, true);
        assert.deepEqual((await a.listTables()).filter((n) => n.startsWith("_moveit_")), []);
      });

      await t.test("append adds rows after a key check, and rollback removes exactly those rows", async () => {
        const { plan, run } = await ok({ source: "extra", target: "x", tables: ["conf_customers"], mode: "append" });
        assert.deepEqual(plan.tables[0].appendKey, [id]);
        assert.equal(run.status, "succeeded", fail(run));
        assert.equal(await a.countRows(customers), N + 10);
        await app.rollback(run.id, run.id);
        assert.equal(await a.countRows(customers), N);
        assert.deepEqual((await a.listTables()).filter((n) => n.startsWith("_moveit_")), []);
      });
    } finally {
      await conns.closeAll();
      await dropAll(sys).catch(() => undefined);
    }
  });
}
