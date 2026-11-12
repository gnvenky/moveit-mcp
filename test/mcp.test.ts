import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "index.js");

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!r.isError, text, json };
}

test("MCP server: full agent flow over stdio, with the safety rails enforced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moveit-mcp-"));
  const db = new DatabaseSync(join(dir, "src.db"));
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, plan TEXT)");
  const ins = db.prepare("INSERT INTO users VALUES (?,?,?)");
  for (let i = 1; i <= 25; i++) ins.run(i, `person${i}@corp.example`, i % 2 ? "pro" : null);
  db.close();
  writeFileSync(
    join(dir, "moveit.config.json"),
    JSON.stringify({ connections: { old: { type: "sqlite", path: join(dir, "src.db"), readOnly: true }, new: { type: "sqlite", path: join(dir, "new.db") }, secret: { type: "postgres", host: "127.0.0.1", port: 1, user: "u", password: "${MOVEIT_TEST_SECRET}", database: "d" } } }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", entry, "mcp"],
    env: { ...(process.env as Record<string, string>), MOVEIT_CONFIG: join(dir, "moveit.config.json"), MOVEIT_HOME: join(dir, ".moveit"), MOVEIT_TEST_SECRET: "s3cr3t-pa55word" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["dry_run", "export_report", "finalize_run", "get_plan", "inspect_schema", "list_connections", "plan_migration", "profile_data", "reconcile", "rollback", "run_migration", "run_status", "sample_rows", "test_connection"],
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.rollback.annotations?.destructiveHint, true);
    assert.equal(byName.dry_run.annotations?.readOnlyHint, true);
    assert.ok(byName.run_migration.description!.includes("staging"));

    const conns = await call(client, "list_connections");
    assert.deepEqual(conns.json.map((c: any) => c.name).sort(), ["new", "old", "secret"]);
    assert.ok(!conns.text.includes("s3cr3t"), "credentials must never be listed");

    const bad = await call(client, "test_connection", { connection: "secret" }); // port 1: refused
    assert.equal(bad.isError, true);
    assert.ok(!bad.text.includes("s3cr3t-pa55word"), "credentials must not leak through errors");

    const sample = await call(client, "sample_rows", { connection: "old", table: "users", limit: 2 });
    assert.equal(sample.json.rows[0].email, "[redacted]");

    const plan = await call(client, "plan_migration", { source: "old", target: "new", tables: ["users"] });
    assert.equal(plan.json.executable, true);
    const { planId, planHash } = plan.json;

    const early = await call(client, "run_migration", { planId, planHash });
    assert.equal(early.isError, true);
    assert.match(early.text, /dry-run/);

    const dry = await call(client, "dry_run", { planId });
    assert.equal(dry.json.ok, true);

    const wrong = await call(client, "run_migration", { planId, planHash: "0000000000000000" });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /planHash does not match/);

    const run = await call(client, "run_migration", { planId, planHash, batchSize: 10 });
    assert.equal(run.json.status, "succeeded", run.text);
    assert.equal(run.json.tables[0].rowsLoaded, 25);

    const rec = await call(client, "reconcile", { planId });
    assert.equal(rec.json.ok, true);

    const nope = await call(client, "rollback", { runId: run.json.id, confirm: "yes" });
    assert.equal(nope.isError, true);
    assert.equal((new DatabaseSync(join(dir, "new.db")).prepare("SELECT COUNT(*) c FROM users").get() as any).c, 25);

    const rep = await call(client, "export_report", { runId: run.json.id });
    assert.equal(rep.json.evidenceChainIntact, true);
    assert.match(rep.json.markdown, /Status:\*\* succeeded/);

    const gone = await call(client, "rollback", { runId: run.json.id, confirm: run.json.id });
    assert.equal(gone.json.status, "rolled_back");
    assert.equal((await call(client, "inspect_schema", { connection: "new" })).json.tables.length, 0);
    assert.equal((await call(client, "inspect_schema", { connection: "old" })).json.tables[0].rows, 25); // source untouched
  } finally {
    await client.close();
  }
});
