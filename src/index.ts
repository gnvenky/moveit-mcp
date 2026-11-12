#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DRIVER_PACKAGE, SUPPORTED } from "./adapters/index.js";
import { Connections, findConfigPath, loadConfig, moveitHome } from "./config.js";
import { startMcp } from "./server.js";
import { Moveit, summarizePlan } from "./service.js";
import { Store } from "./store.js";
import type { TableOverride } from "./types.js";

const EXAMPLE = {
  connections: {
    legacy_pg: { type: "postgres", url: "${LEGACY_PG_URL}", readOnly: true },
    old_mysql: { type: "mysql", host: "db.internal", user: "readonly", password: "${MYSQL_PASSWORD}", database: "shop", readOnly: true },
    erp_oracle: { type: "oracle", user: "READER", password: "${ORACLE_PASSWORD}", connectString: "dbhost:1521/ORCLPDB1", schema: "ERP", readOnly: true },
    warehouse: {
      type: "snowflake",
      account: "myorg-myaccount",
      username: "MOVEIT",
      password: "${SNOWFLAKE_PASSWORD}",
      warehouse: "LOAD_WH",
      database: "ANALYTICS",
      schema: "RAW",
      role: "LOADER",
    },
    lakehouse: {
      type: "databricks",
      host: "adb-1234567890123456.7.azuredatabricks.net",
      httpPath: "/sql/1.0/warehouses/abcdef1234567890",
      token: "${DATABRICKS_TOKEN}",
      catalog: "main",
      schema: "raw",
    },
    exports: { type: "csv", path: "./exports", readOnly: true },
    local: { type: "sqlite", path: "./local.db" },
  },
};

const USAGE = `moveit: safe data migration for coding agents

Usage:
  moveit mcp [--config FILE]                    Start the MCP server on stdio
  moveit setup [--config FILE] [--force]        Write an example config and print MCP client settings
  moveit doctor [--config FILE]                 Check Node, drivers and connections
  moveit inspect <connection> [--config FILE]   Show tables and column types
  moveit migrate --source A --target B [--tables t1,t2] [--naming convention|preserve] [--yes]
                 [--mode create|replace|append] [--skip-objects indexes,foreign-keys,defaults,identity]
                                                Plan, dry-run, then (with --yes) run, verify and report
  moveit finalize <runId> --yes                 Drop the backups (replace) or staging tables (append) a run kept
  moveit rollback <runId> --yes                 Undo a run: restore replaced tables, remove what it added

Config: ${"moveit.config.json"} (or MOVEIT_CONFIG). Secrets go in environment variables: "\${NAME}".
Supported: ${SUPPORTED.join(", ")}
`;

function flags(argv: string[]): { pos: string[]; f: Record<string, string | boolean> } {
  const pos: string[] = [];
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        f[k] = next;
        i++;
      } else f[k] = true;
    } else pos.push(a);
  }
  return { pos, f };
}

async function withApp<T>(configPath: string | undefined, fn: (app: Moveit) => Promise<T>): Promise<T> {
  const { config } = loadConfig(configPath);
  const conns = new Connections(config);
  try {
    return await fn(new Moveit(config, conns, new Store(moveitHome(config))));
  } finally {
    await conns.closeAll();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, f } = flags(rest);
  const cfg = typeof f.config === "string" ? f.config : undefined;

  switch (cmd) {
    case "mcp":
      return startMcp(cfg);

    case "setup": {
      const path = findConfigPath(cfg);
      if (existsSync(path) && !f.force) console.log(`Config already exists: ${path} (use --force to overwrite)`);
      else {
        writeFileSync(path, JSON.stringify(EXAMPLE, null, 2) + "\n");
        console.log(`Wrote example config: ${path}\nEdit it, keep passwords in environment variables, and mark sources readOnly.`);
      }
      console.log(
        "\nAdd this to your MCP client (Claude Code, Cursor, Codex, ...):\n" +
          JSON.stringify({ mcpServers: { moveit: { command: "moveit", args: ["mcp"], env: { MOVEIT_CONFIG: path } } } }, null, 2),
      );
      return;
    }

    case "doctor": {
      let bad = 0;
      const line = (ok: boolean, msg: string) => {
        if (!ok) bad++;
        console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
      };
      const major = Number(process.versions.node.split(".")[0]);
      line(major >= 22, `Node ${process.versions.node} (need 22.13+ for built-in SQLite)`);
      let loaded;
      try {
        loaded = loadConfig(cfg);
        line(true, `config ${loaded.path}`);
      } catch (e: any) {
        line(false, e.message);
        process.exitCode = 1;
        return;
      }
      const conns = new Connections(loaded.config);
      for (const [name, c] of Object.entries(loaded.config.connections)) {
        const pkg = DRIVER_PACKAGE[c.type];
        if (pkg) {
          try {
            await import(pkg);
          } catch {
            line(false, `${name}: driver "${pkg}" not installed (npm install ${pkg})`);
            continue;
          }
        }
        try {
          const a = await conns.get(name);
          line(true, `${name}: ${await a.ping()}${a.readOnly ? " [read-only]" : ""}`);
        } catch (e: any) {
          line(false, `${name}: ${e.message}`);
        }
      }
      await conns.closeAll();
      process.exitCode = bad ? 1 : 0;
      return;
    }

    case "inspect": {
      if (!pos[0]) throw new Error("Usage: moveit inspect <connection>");
      return withApp(cfg, async (app) => {
        const r = await app.inspectSchema(pos[0]);
        for (const t of r.tables) {
          console.log(`\n${t.table}  (${t.rows} rows${t.primaryKey.length ? ", PK " + t.primaryKey.join("+") : ""})`);
          for (const c of t.columns) console.log(`  ${c.name.padEnd(28)} ${String(c.native).padEnd(24)} -> ${c.type}${c.nullable ? "" : " NOT NULL"}`);
        }
      });
    }

    case "migrate": {
      const source = String(f.source ?? "");
      const target = String(f.target ?? "");
      if (!source || !target) throw new Error("migrate needs --source and --target");
      const tables = typeof f.tables === "string" ? f.tables.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      let overrides: TableOverride[] | undefined;
      if (typeof f.overrides === "string") overrides = JSON.parse((await import("node:fs")).readFileSync(resolve(f.overrides), "utf8"));
      const naming = f.naming === "convention" || f.naming === "preserve" ? f.naming : undefined;
      const mode = f.mode === "replace" || f.mode === "append" || f.mode === "create" ? f.mode : undefined;
      if (f.mode !== undefined && !mode) throw new Error("--mode must be create, replace or append");
      const off = typeof f["skip-objects"] === "string" ? String(f["skip-objects"]).split(",").map((s) => s.trim()) : [];
      const objects = {
        indexes: !off.includes("indexes"),
        foreignKeys: !off.includes("foreign-keys"),
        defaults: !off.includes("defaults"),
        identity: !off.includes("identity"),
      };
      return withApp(cfg, async (app) => {
        const { plan } = await app.plan({ source, target, tables, overrides, naming, mode, objects });
        const s = summarizePlan(plan);
        console.log(`Plan ${plan.id} (hash ${plan.hash}): ${plan.tables.length} table(s)`);
        for (const t of s.tables) console.log(`  ${t.source} -> ${t.target}  ${t.rows} rows, ${t.columns.length} columns`);
        for (const i of s.issues.filter((x) => x.severity !== "info")) console.log(`  [${i.severity}] ${i.table ?? ""}${i.column ? "." + i.column : ""}: ${i.message}`);
        if (!s.executable) {
          process.exitCode = 1;
          return console.log("\nPlan has errors; fix them (see above) and try again.");
        }
        const dr = await app.dryRun(plan.id);
        for (const t of dr.tables) {
          console.log(`  dry run ${t.table}: ${t.rowsChecked} rows, ${t.rowsFailed} failing`);
          for (const x of t.failures) console.log(`    ${x.column} [${x.code}] x${x.count}: ${x.examples[0]?.reason} (${x.examples[0]?.row})`);
        }
        if (!dr.ok) {
          process.exitCode = 1;
          return console.log("\nDry run found problems; nothing was written.");
        }
        if (!f.yes) return console.log(`\nDry run passed. Nothing written. Re-run with --yes to migrate.`);
        const run = await app.run(plan.id, { planHash: plan.hash });
        console.log(`\nRun ${run.id}: ${run.status}`);
        for (const t of run.tables) console.log(`  ${t.targetTable}: ${t.status}, ${t.rowsLoaded} rows${t.verify ? (t.verify.ok ? ", verified" : ", VERIFY FAILED") : ""}${t.error ? "\n    " + t.error : ""}`);
        for (const w of run.warnings) console.log(`  note: ${w}`);
        for (const c of run.constraintFailures) console.log(`  could not create ${c.name} on ${c.table}: ${c.error}\n    ${c.sql}`);
        const rep = app.report(run.id);
        console.log(`Report: ${rep.path}`);
        process.exitCode = run.status === "succeeded" ? 0 : 1;
      });
    }

    case "finalize":
    case "rollback": {
      if (!pos[0]) throw new Error(`Usage: moveit ${cmd} <runId> --yes`);
      if (!f.yes) throw new Error(`${cmd} changes the target database. Re-run with --yes to confirm.`);
      return withApp(cfg, async (app) => {
        const run = cmd === "finalize" ? await app.finalize(pos[0], pos[0]) : await app.rollback(pos[0], pos[0]);
        console.log(`Run ${run.id}: ${run.status}${run.finalized ? " (finalized)" : ""}`);
      });
    }

    default:
      console.log(USAGE);
      process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(`moveit: ${e?.message ?? e}`);
  process.exit(1);
});
