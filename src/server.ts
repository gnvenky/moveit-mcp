import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Connections, loadConfig, moveitHome } from "./config.js";
import { jsonSafe } from "./redact.js";
import { Moveit, summarizePlan } from "./service.js";
import { Store } from "./store.js";
import { CANONICAL_TYPES, type CanonicalType } from "./types.js";

const typeEnum = z.enum(CANONICAL_TYPES as [CanonicalType, ...CanonicalType[]]);

const overrideSchema = z.object({
  source: z.string().describe("Source table this override applies to"),
  target: z.string().optional().describe("Target table name"),
  exclude: z.array(z.string()).optional().describe("Source columns to leave out"),
  renames: z.record(z.string()).optional().describe("Source column -> target column name"),
  typeOverrides: z
    .record(
      z.object({
        type: typeEnum,
        length: z.number().int().positive().optional(),
        precision: z.number().int().positive().optional(),
        scale: z.number().int().min(0).optional(),
      }),
    )
    .optional()
    .describe("Source column -> canonical target type"),
  primaryKey: z.array(z.string()).optional().describe("Set the primary key (source column names), e.g. for CSV sources"),
});

export function createServer(app: Moveit): McpServer {
  const server = new McpServer({ name: "moveit", version: "0.2.0" });

  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(jsonSafe(data), null, 2) }] });
  const guard =
    <A>(fn: (a: A) => Promise<unknown> | unknown) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e: any) {
        return { isError: true, content: [{ type: "text" as const, text: app.scrub(String(e?.message ?? e)) }] };
      }
    };

  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const DESTRUCT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

  server.registerTool(
    "list_connections",
    { title: "List connections", description: "List the named database connections configured for this server (names, types, read-only flag). Credentials are never returned.", annotations: READ },
    guard(async () => app.listConnections()),
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test connection",
      description: "Connect to a named connection and report whether it works.",
      inputSchema: { connection: z.string() },
      annotations: READ,
    },
    guard(async (a: { connection: string }) => app.testConnection(a.connection)),
  );

  server.registerTool(
    "inspect_schema",
    {
      title: "Inspect schema",
      description: "List tables with columns, native and canonical types, nullability, primary keys and row counts.",
      inputSchema: { connection: z.string(), tables: z.array(z.string()).optional() },
      annotations: READ,
    },
    guard(async (a: { connection: string; tables?: string[] }) => app.inspectSchema(a.connection, a.tables)),
  );

  server.registerTool(
    "sample_rows",
    {
      title: "Sample rows",
      description: "Return a few rows from a table. Sensitive-looking columns and values (emails, card numbers, SSNs, names, addresses) are redacted unless redact=false.",
      inputSchema: {
        connection: z.string(),
        table: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
        redact: z.boolean().optional(),
      },
      annotations: READ,
    },
    guard(async (a: { connection: string; table: string; limit?: number; redact?: boolean }) =>
      app.sampleRows(a.connection, a.table, a.limit, a.redact ?? true),
    ),
  );

  server.registerTool(
    "profile_data",
    {
      title: "Profile data",
      description: "Per-column null counts, distinct counts, lengths, min/max and uniqueness from a sample of rows. Use it to spot bad data and candidate keys before planning.",
      inputSchema: { connection: z.string(), table: z.string(), sampleSize: z.number().int().min(100).max(100000).optional() },
      annotations: READ,
    },
    guard(async (a: { connection: string; table: string; sampleSize?: number }) => app.profile(a.connection, a.table, a.sampleSize)),
  );

  server.registerTool(
    "plan_migration",
    {
      title: "Plan migration",
      description:
        "Propose the mapping from source tables to target tables: column types, names, primary keys, identity columns, defaults, indexes, foreign keys, DDL, and conflicts (existing targets, name collisions, overflow risks). mode create (default) makes new tables; replace swaps in a new table and keeps the old one as a backup until finalize_run; append adds rows to an existing table after checking keys. Writes nothing to either database. Returns a planId and planHash. Adjust with overrides and plan again.",
      inputSchema: {
        source: z.string().describe("Connection name to read from"),
        target: z.string().describe("Connection name to write to"),
        tables: z.array(z.string()).optional().describe("Tables to migrate (default: all)"),
        overrides: z.array(overrideSchema).optional(),
        naming: z.enum(["convention", "preserve"]).optional().describe("Rename identifiers to the target's style, or keep them. Default: preserve when source and target are the same kind."),
        mode: z.enum(["create", "replace", "append"]).optional().describe("create: new tables only (default). replace: swap in a new table, keep the old as a backup until finalize_run. append: add rows to an existing table."),
        objects: z
          .object({
            indexes: z.boolean().optional(),
            foreignKeys: z.boolean().optional(),
            defaults: z.boolean().optional(),
            identity: z.boolean().optional(),
          })
          .optional()
          .describe("Leave out indexes, foreign keys, defaults or auto-generated keys by setting them to false. All are carried over by default where the target supports them."),
      },
      annotations: WRITE,
    },
    guard(async (a: any) => summarizePlan((await app.plan(a)).plan)),
  );

  server.registerTool(
    "get_plan",
    {
      title: "Get plan",
      description: "Show a plan again, including whether its dry run has passed.",
      inputSchema: { planId: z.string() },
      annotations: READ,
    },
    guard(async (a: { planId: string }) => {
      const rec = app.getPlan(a.planId);
      return { ...summarizePlan(rec.plan), dryRun: rec.dryRun && { ok: rec.dryRun.ok, complete: rec.dryRun.complete, at: rec.dryRun.at, matchesPlan: rec.dryRun.planHash === rec.plan.hash } };
    }),
  );

  server.registerTool(
    "dry_run",
    {
      title: "Dry run",
      description:
        "Read every source row and check it converts to the target types (ranges, precision, lengths, NOT NULL, dates, JSON...). Writes nothing. Reports failures per column with example row keys. A complete, passing dry run is required before run_migration. Values are hidden in examples unless showValues=true.",
      inputSchema: {
        planId: z.string(),
        maxRows: z.number().int().positive().optional().describe("Stop early for a quick check. A partial dry run cannot authorise a migration."),
        showValues: z.boolean().optional(),
      },
      annotations: READ,
    },
    guard(async (a: { planId: string; maxRows?: number; showValues?: boolean }) => app.dryRun(a.planId, a)),
  );

  server.registerTool(
    "run_migration",
    {
      title: "Run migration",
      description:
        "Execute a dry-run-approved plan. Reads every table from one point-in-time view where the source supports it, loads each into a hidden staging table, reads it back and compares row counts and digests against the source, and only then promotes (rename for create/replace, insert-from-staging for append). If anything fails, nothing is promoted and existing tables are untouched. Replace keeps the old tables as backups and append keeps its staging tables until finalize_run. Requires the planHash from plan_migration. Use maxBatches to run in chunks and resumeRunId to continue.",
      inputSchema: {
        planId: z.string(),
        planHash: z.string().describe("The planHash returned by plan_migration, confirming you reviewed this exact plan"),
        batchSize: z.number().int().min(1).max(100000).optional(),
        maxBatches: z.number().int().positive().optional(),
        resumeRunId: z.string().optional(),
        prefetch: z.number().int().min(0).max(8).optional().describe("Batches to read ahead while the previous one is written. Default 2; 0 turns pipelining off."),
      },
      annotations: WRITE,
    },
    guard(async (a: { planId: string; planHash: string; batchSize?: number; maxBatches?: number; resumeRunId?: string; prefetch?: number }) =>
      app.run(a.planId, a),
    ),
  );

  server.registerTool(
    "run_status",
    { title: "Run status", description: "Progress and per-table state of a run.", inputSchema: { runId: z.string() }, annotations: READ },
    guard(async (a: { runId: string }) => app.runStatus(a.runId)),
  );

  server.registerTool(
    "reconcile",
    {
      title: "Reconcile",
      description: "Re-read the source and the migrated target tables now and compare row counts and per-column digests. Run it after a migration, or later to detect drift.",
      inputSchema: { planId: z.string() },
      annotations: READ,
    },
    guard(async (a: { planId: string }) => app.reconcile(a.planId)),
  );

  server.registerTool(
    "finalize_run",
    {
      title: "Finalize run",
      description:
        "Make a succeeded run permanent: drops the backups left by a replace and the staging tables left by an append. After this the run can no longer be rolled back. Destructive: requires confirm equal to the runId. Never touches the source.",
      inputSchema: { runId: z.string(), confirm: z.string().describe("Must equal runId") },
      annotations: DESTRUCT,
    },
    guard(async (a: { runId: string; confirm: string }) => app.finalize(a.runId, a.confirm)),
  );

  server.registerTool(
    "rollback",
    {
      title: "Roll back run",
      description: "Undo a run: drops staging tables and newly created tables, restores tables a replace set aside, and deletes appended rows by key. Not possible after finalize_run. Destructive: requires confirm equal to the runId. Never touches the source.",
      inputSchema: { runId: z.string(), confirm: z.string().describe("Must equal runId") },
      annotations: DESTRUCT,
    },
    guard(async (a: { runId: string; confirm: string }) => app.rollback(a.runId, a.confirm)),
  );

  server.registerTool(
    "export_report",
    {
      title: "Export report",
      description: "Build a Markdown report of a run (tables, verification, warnings) and check the integrity of its evidence log.",
      inputSchema: { runId: z.string() },
      annotations: WRITE,
    },
    guard(async (a: { runId: string }) => {
      const r = app.report(a.runId);
      return { path: r.path, evidenceChainIntact: r.evidenceOk, markdown: r.markdown };
    }),
  );

  return server;
}

export async function startMcp(configPath?: string): Promise<void> {
  const { config } = loadConfig(configPath);
  const conns = new Connections(config);
  const app = new Moveit(config, conns, new Store(moveitHome(config)));
  const server = createServer(app);
  const close = async () => {
    await conns.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await server.connect(new StdioServerTransport());
  process.stderr.write("moveit MCP server ready (stdio)\n");
}
