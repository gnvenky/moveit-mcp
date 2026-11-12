import { randomBytes } from "node:crypto";
import { TableDigest, coerce } from "./canonical.js";
import { scrub, type MoveitConfig } from "./config.js";
import { EvidenceLog } from "./evidence.js";
import { STAGING_PREFIX, backupName, hashPlan, identityStartFrom, planErrors, pkNameFor, stagingName } from "./planner.js";
import type { Store } from "./store.js";
import type {
  Adapter,
  ColumnInfo,
  DdlOptions,
  DryRunResult,
  DryRunTableResult,
  FailureSummary,
  Plan,
  PlanRecord,
  RunState,
  TableInfo,
  TablePlan,
  TableRunState,
  VerifyResult,
} from "./types.js";

export interface Ctx {
  src: Adapter;
  tgt: Adapter;
  store: Store;
  config?: MoveitConfig;
}

// ------------------------------------------------------------------ row transform

class FailureCollector {
  rowsFailed = 0;
  emptyStringsToNull = 0;
  private map = new Map<string, FailureSummary>();
  add(column: string, code: string, reason: string, row: string, value: string | undefined): void {
    const key = `${column}\u0000${code}`;
    let f = this.map.get(key);
    if (!f) this.map.set(key, (f = { column, code, count: 0, examples: [] }));
    f.count++;
    if (f.examples.length < 3) f.examples.push({ row, reason, ...(value !== undefined ? { value } : {}) });
  }
  summaries(): FailureSummary[] {
    return [...this.map.values()].sort((a, b) => b.count - a.count);
  }
}

function describeValue(v: unknown, show: boolean): string | undefined {
  if (!show) return undefined;
  if (v === null || v === undefined) return "null";
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<binary ${v.length} bytes>`;
  const s = typeof v === "string" ? v : String(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

/** Coerce one source row to the target's canonical form. Returns null when any value fails (and records why). */
export function transformRow(
  raw: unknown[],
  tp: TablePlan,
  tgt: Adapter,
  rowNo: number,
  fc?: FailureCollector,
  showValues = false,
): unknown[] | null {
  const out: unknown[] = new Array(tp.columns.length);
  let failed = false;
  const label = () => {
    if (!tp.primaryKey.length) return `row ${rowNo}`;
    const vals = tp.primaryKey.map((k) => {
      const i = tp.columns.findIndex((c) => c.target.name === k);
      return `${k}=${String(raw[i]).slice(0, 40)}`;
    });
    return vals.join(", ");
  };
  for (let i = 0; i < tp.columns.length; i++) {
    const t = tp.columns[i].target;
    const r = coerce(raw[i], t);
    if (!r.ok) {
      failed = true;
      fc?.add(t.name, r.code, r.reason, label(), describeValue(raw[i], showValues));
      continue;
    }
    let v = r.value;
    if (tgt.emptyStringIsNull && v === "" && (t.type === "string" || t.type === "text")) {
      v = null;
      if (fc) fc.emptyStringsToNull++;
    }
    if (v === null && !t.nullable) {
      failed = true;
      const why =
        raw[i] === "" && tgt.emptyStringIsNull
          ? `empty string would become NULL on ${tgt.label}, but the column is NOT NULL`
          : "NULL in a NOT NULL column";
      fc?.add(t.name, "null_in_not_null", why, label(), undefined);
      continue;
    }
    if (
      tgt.maxStringBytes !== undefined &&
      t.type === "string" &&
      t.length !== undefined &&
      typeof v === "string" &&
      Buffer.byteLength(v, "utf8") > tgt.maxStringBytes
    ) {
      failed = true;
      fc?.add(t.name, "too_long_bytes", `exceeds ${tgt.maxStringBytes} bytes in UTF-8`, label(), describeValue(raw[i], showValues));
      continue;
    }
    out[i] = v;
  }
  if (failed) {
    if (fc) fc.rowsFailed++;
    return null;
  }
  return out;
}

const targetColumns = (tp: TablePlan): ColumnInfo[] => tp.columns.map((c) => c.target);
const sourceNames = (tp: TablePlan): string[] => tp.columns.map((c) => c.source.name);
const targetInfo = (tp: TablePlan, name: string): TableInfo => ({
  name,
  columns: targetColumns(tp),
  primaryKey: tp.primaryKey,
});

// ------------------------------------------------------------------ dry run

export async function dryRun(
  ctx: Ctx,
  plan: Plan,
  opts: { maxRows?: number; batchSize?: number; showValues?: boolean } = {},
): Promise<DryRunResult> {
  const batchSize = opts.batchSize ?? 5000;
  const tables: DryRunTableResult[] = [];
  let complete = true;
  for (const tp of plan.tables) {
    const fc = new FailureCollector();
    let rows = 0;
    outer: for await (const b of ctx.src.readRows(tp.sourceTable, { columns: sourceNames(tp), batchSize })) {
      for (const r of b.rows) {
        if (opts.maxRows !== undefined && rows >= opts.maxRows) {
          complete = false;
          break outer;
        }
        rows++;
        transformRow(r, tp, ctx.tgt, rows, fc, opts.showValues);
      }
    }
    if (tp.createPrimaryKey && opts.maxRows === undefined) {
      const srcKey = tp.primaryKey.map((k) => tp.columns.find((c) => c.target.name === k)!.source.name);
      const dupes = await ctx.src.countDuplicateKeys(tp.sourceTable, srcKey);
      if (dupes > 0)
        fc.add(
          srcKey.join(", "),
          "duplicate_key",
          `${dupes} primary-key value(s) appear more than once in the source, so the target key cannot be created`,
          "see source",
          undefined,
        );
    }
    tables.push({
      table: tp.sourceTable,
      rowsChecked: rows,
      rowsFailed: fc.rowsFailed,
      emptyStringsToNull: fc.emptyStringsToNull,
      failures: fc.summaries(),
    });
  }
  return {
    planHash: plan.hash,
    at: new Date().toISOString(),
    complete,
    ok: complete && tables.every((t) => t.rowsFailed === 0 && t.failures.length === 0),
    tables,
  };
}

// ------------------------------------------------------------------ digests

async function sourceDigest(ctx: Ctx, tp: TablePlan, batchSize: number): Promise<{ digest: TableDigest; failed: number }> {
  const d = new TableDigest(targetColumns(tp));
  let failed = 0;
  let n = 0;
  for await (const b of ctx.src.readRows(tp.sourceTable, { columns: sourceNames(tp), batchSize }))
    for (const r of b.rows) {
      const v = transformRow(r, tp, ctx.tgt, ++n);
      if (v) d.add(v);
      else failed++;
    }
  return { digest: d, failed };
}

/** Read a target table back and digest it using the planned types, so driver quirks cannot cause false mismatches. */
async function targetDigest(ctx: Ctx, table: string, tp: TablePlan, batchSize: number): Promise<{ digest: TableDigest; failed: number }> {
  const cols = targetColumns(tp);
  const d = new TableDigest(cols);
  let failed = 0;
  for await (const b of ctx.tgt.readRows(table, { columns: cols.map((c) => c.name), batchSize }))
    for (const raw of b.rows) {
      const row: unknown[] = [];
      let bad = false;
      for (let i = 0; i < cols.length; i++) {
        const r = coerce(raw[i], cols[i]);
        if (!r.ok) {
          bad = true;
          break;
        }
        let v = r.value;
        if (ctx.tgt.emptyStringIsNull && v === "" && (cols[i].type === "string" || cols[i].type === "text")) v = null;
        row.push(v);
      }
      if (bad) failed++;
      else d.add(row);
    }
  return { digest: d, failed };
}

function compare(src: TableDigest, tgt: TableDigest, unreadable: number): VerifyResult {
  const a = src.result();
  const b = tgt.result();
  const mismatched = Object.keys(a.columns).filter((c) => a.columns[c] !== b.columns[c]);
  return {
    ok: a.rows === b.rows && a.digest === b.digest && unreadable === 0,
    sourceRows: a.rows,
    targetRows: b.rows + unreadable,
    sourceDigest: a.digest,
    targetDigest: b.digest,
    mismatchedColumns: mismatched,
  };
}

export interface ReconcileResult {
  ok: boolean;
  /** False for append plans: the target also holds rows from before, so whole tables cannot be compared. */
  comparable: boolean;
  tables: { table: string; target: string; exists: boolean; verify?: VerifyResult; note?: string }[];
}

/** Re-read both sides now and compare. Safe to run any time after a migration. */
export async function reconcile(ctx: Ctx, plan: Plan, batchSize = 5000): Promise<ReconcileResult> {
  const tables: ReconcileResult["tables"] = [];
  if (plan.mode === "append") {
    for (const tp of plan.tables)
      tables.push({ table: tp.sourceTable, target: tp.targetTable, exists: true, note: "this plan appends to existing data, so the target holds other rows too and whole-table comparison does not apply" });
    return { ok: false, comparable: false, tables };
  }
  for (const tp of plan.tables) {
    if (!(await ctx.tgt.tableExists(tp.targetTable))) {
      tables.push({ table: tp.sourceTable, target: tp.targetTable, exists: false, note: "target table does not exist" });
      continue;
    }
    const [s, t] = await Promise.all([sourceDigest(ctx, tp, batchSize), targetDigest(ctx, tp.targetTable, tp, batchSize)]);
    const verify = compare(s.digest, t.digest, t.failed);
    tables.push({
      table: tp.sourceTable,
      target: tp.targetTable,
      exists: true,
      verify: { ...verify, ok: verify.ok && s.failed === 0 },
      note: s.failed ? `${s.failed} source rows no longer pass validation` : undefined,
    });
  }
  return { ok: tables.every((t) => t.exists && t.verify?.ok), comparable: true, tables };
}

// ------------------------------------------------------------------ run

export interface RunOptions {
  planHash: string;
  batchSize?: number;
  /** Stop staging after this many batches in total and return status "partial". Call again with resumeRunId. */
  maxBatches?: number;
  resumeRunId?: string;
  /** Batches read ahead of the one being written. 0 turns pipelining off. Default 2. */
  prefetch?: number;
}

class StopForBudget extends Error {}

/**
 * Keep up to `depth` reads of `src` in flight while the consumer works on the current item, so reading
 * the next batch from the source overlaps with writing the previous one to the target.
 */
export async function* prefetch<T>(src: AsyncIterable<T>, depth = 2): AsyncGenerator<T> {
  if (depth <= 0) {
    yield* src;
    return;
  }
  const it = src[Symbol.asyncIterator]();
  const queue: Promise<IteratorResult<T>>[] = [];
  let finished = false;
  const pull = () => {
    if (finished) return;
    const p = it.next();
    p.catch(() => undefined); // an unconsumed rejection must not crash the process; the awaited copy still throws
    queue.push(p);
  };
  try {
    for (let i = 0; i < depth; i++) pull();
    while (queue.length) {
      const r = await queue.shift()!;
      if (r.done) {
        finished = true;
        return;
      }
      pull(); // start the next read before handing this batch to the writer
      yield r.value;
    }
  } finally {
    finished = true;
    await Promise.allSettled(queue);
    try {
      await it.return?.(undefined);
    } catch {
      /* closing a half-read source is best effort */
    }
  }
}

export function checkRunnable(rec: PlanRecord, planHash: string): void {
  const { plan, dryRun: dr } = rec;
  if (hashPlan(plan) !== plan.hash) throw new Error("Plan file was modified after it was created; create a new plan.");
  if (planHash !== plan.hash)
    throw new Error(`planHash does not match this plan (expected ${plan.hash}). Re-read the plan and confirm its hash.`);
  const errs = planErrors(plan);
  if (errs.length) throw new Error(`Plan has ${errs.length} error(s); fix them first: ${errs.map((e) => e.message).join(" | ")}`);
  if (!dr) throw new Error("This plan has not been dry-run. Run dry_run first.");
  if (dr.planHash !== plan.hash) throw new Error("The dry run belongs to a different version of the plan. Run dry_run again.");
  if (!dr.complete) throw new Error("The dry run was partial (maxRows). Run a complete dry run first.");
  if (!dr.ok) throw new Error("The dry run found rows that cannot be migrated. Fix the plan (overrides) or the data, then dry-run again.");
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/** DDL for a table's staging copy: identity continues from the value computed for this run. */
function stagingDdl(ctx: Ctx, tp: TablePlan, ts: TableRunState, run: RunState): { info: TableInfo; opts: DdlOptions } {
  const columns = targetColumns(tp).map((c) => (c.identity && ts.identityStart ? { ...c, identity: { start: ts.identityStart } } : c));
  const salt = run.mode === "create" ? undefined : run.id.replace(/^run_/, "").slice(0, 4);
  return {
    info: { name: ts.stagingTable, columns, primaryKey: tp.primaryKey },
    opts: {
      withPrimaryKey: tp.createPrimaryKey,
      pkName: pkNameFor(tp.targetTable, ctx.tgt.maxIdentifierLength, salt),
      foreignKeys: ctx.tgt.foreignKeyMode === "inline" && run.mode !== "append" ? tp.foreignKeys : undefined,
    },
  };
}

export async function executeRun(ctx: Ctx, rec: PlanRecord, opts: RunOptions): Promise<RunState> {
  checkRunnable(rec, opts.planHash);
  const plan = rec.plan;
  if (ctx.tgt.readOnly) throw new Error(`Target connection "${plan.target}" is marked readOnly.`);
  const batchSize = opts.batchSize ?? ctx.tgt.preferredBatchSize ?? 5000;
  const mode = plan.mode;

  let run: RunState;
  let resumed = false;
  if (opts.resumeRunId) {
    run = ctx.store.loadRun(opts.resumeRunId);
    if (run.planId !== plan.id || run.planHash !== plan.hash) throw new Error("That run belongs to a different plan.");
    if (run.status === "succeeded" || run.status === "rolled_back") throw new Error(`Run is already ${run.status}.`);
    run.status = "running";
    run.error = undefined;
    resumed = true;
  } else {
    const existing = await ctx.tgt.listTables();
    for (const tp of plan.tables) {
      const exists = existing.includes(tp.targetTable);
      if (mode === "create" && exists) throw new Error(`Target table "${tp.targetTable}" now exists. Nothing was changed.`);
      if (mode === "append" && !exists) throw new Error(`Target table "${tp.targetTable}" no longer exists. Nothing was changed.`);
      if (mode === "replace" && exists !== !!tp.existingTarget)
        throw new Error(`Target table "${tp.targetTable}" ${exists ? "now exists" : "no longer exists"}, which differs from the plan. Create a new plan. Nothing was changed.`);
      if (exists && tp.existingTarget) {
        const now = await ctx.tgt.describeTable(tp.targetTable);
        if (!sameSet(now.columns.map((c) => c.name), tp.existingTarget.columns))
          throw new Error(`The columns of "${tp.targetTable}" changed since the plan was made. Create a new plan. Nothing was changed.`);
      }
      // a failed or paused run keeps its staging table (and its primary-key name), which would collide with a new run
      const leftover = existing.find((n) => n.startsWith(STAGING_PREFIX) && n.endsWith(`_${tp.targetTable}`));
      if (leftover)
        throw new Error(
          `Leftover table "${leftover}" from an earlier run exists. Resume that run (resumeRunId), finalize it, or call rollback on it, then try again. Nothing was changed.`,
        );
    }
    const id = `run_${randomBytes(4).toString("hex")}`;
    run = {
      id,
      planId: plan.id,
      planHash: plan.hash,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      mode,
      warnings: [],
      snapshot: "none",
      foreignKeys: [],
      constraintFailures: [],
      rollbackable: mode !== "append" || plan.tables.every((t) => t.appendKey?.length),
      tables: plan.tables.map<TableRunState>((tp) => ({
        sourceTable: tp.sourceTable,
        targetTable: tp.targetTable,
        stagingTable: stagingName(id, tp.targetTable),
        status: "pending",
        rowsRead: 0,
        rowsLoaded: 0,
        stagingCreated: false,
        ...(tp.appendKey ? { appendKey: tp.appendKey } : {}),
      })),
    };
    if (!ctx.src.readOnly)
      run.warnings.push(`Source connection "${plan.source}" is not marked readOnly. moveit never writes to the source, but a read-only database user is safer.`);
    if (!run.rollbackable) run.warnings.push("This append has no key on some tables, so the appended rows cannot be removed again by rollback.");
  }
  const ev = new EvidenceLog(ctx.store.evidenceFile(run.id));
  if (!resumed)
    ev.append("run_started", {
      runId: run.id,
      planId: plan.id,
      planHash: plan.hash,
      mode,
      source: { name: plan.source, kind: plan.sourceKind },
      target: { name: plan.target, kind: plan.targetKind },
      dryRun: rec.dryRun && { at: rec.dryRun.at, tables: rec.dryRun.tables.map((t) => ({ table: t.table, rows: t.rowsChecked, emptyStringsToNull: t.emptyStringsToNull })) },
      tables: plan.tables.map((t) => ({ source: t.sourceTable, target: t.targetTable, ddl: t.ddl })),
      warnings: run.warnings,
    });
  else ev.append("run_resumed", { runId: run.id });
  ctx.store.saveRun(run);

  let batches = 0;
  const budget = opts.maxBatches ?? Infinity;
  const fail = (ts: TableRunState | undefined, e: unknown) => {
    const msg = scrub(String((e as any)?.message ?? e), ctx.config);
    if (ts) {
      ts.status = "failed";
      ts.error = msg;
    }
    run.status = "failed";
    run.error = msg;
    ev.append("run_failed", { table: ts?.sourceTable, error: msg });
    ctx.store.saveRun(run);
    return run;
  };
  const isDone = (ts: TableRunState) => ts.status === "staged" || ts.status === "verified" || ts.status === "promoted";

  // ---- phase 1: stage every table, all reads taken from one point-in-time view where the source supports it
  let snapshotOn = false;
  const needsStaging = run.tables.some((t) => !isDone(t));
  const hadProgress = run.tables.some((t) => t.rowsRead > 0 || isDone(t));
  if (needsStaging && plan.source !== plan.target) {
    try {
      snapshotOn = await ctx.src.beginSnapshot();
    } catch (e) {
      run.warnings.push(`Could not start a consistent snapshot of the source (${scrub(String((e as Error).message ?? e), ctx.config)}); reading without one.`);
    }
  } else if (needsStaging && plan.source === plan.target) {
    run.warnings.push("Source and target are the same connection, so no consistent snapshot was used.");
  }
  if (hadProgress) run.snapshot = snapshotOn || run.snapshot === "consistent" ? "interrupted" : "none";
  else run.snapshot = snapshotOn ? "consistent" : "none";
  if (resumed && run.snapshot === "interrupted")
    run.warnings.push("This run was paused and resumed, so tables staged before and after the pause were read at different moments.");
  ev.append("snapshot", { mode: run.snapshot });
  // tables staged from their first row inside the snapshot we hold now
  const freshInSnapshot = new Set<string>(snapshotOn ? run.tables.filter((t) => !isDone(t) && t.rowsRead === 0).map((t) => t.sourceTable) : []);

  const stageAll = async (): Promise<RunState | undefined> => {
    for (const tp of plan.tables) {
      const ts = run.tables.find((t) => t.sourceTable === tp.sourceTable)!;
      if (isDone(ts)) continue;
      try {
        // Resume safety: the checkpoint is written after a batch lands, so a crash in between leaves rows the
        // checkpoint does not know about. Only trust the cursor when the staging table agrees with it.
        if (ts.stagingCreated) {
          const exists = await ctx.tgt.tableExists(ts.stagingTable);
          const loaded = exists ? await ctx.tgt.countRows(ts.stagingTable) : -1;
          if (loaded !== ts.rowsLoaded) {
            run.warnings.push(
              `${tp.sourceTable}: staging held ${loaded < 0 ? "no table" : `${loaded} rows`} but the checkpoint recorded ${ts.rowsLoaded}; restarted this table from the beginning.`,
            );
            ev.append("table_restarted", { table: tp.sourceTable, stagingRows: loaded, checkpointRows: ts.rowsLoaded });
            if (exists) await ctx.tgt.dropTable(ts.stagingTable);
            ts.stagingCreated = false;
            ts.cursor = undefined;
            ts.rowsRead = 0;
            ts.rowsLoaded = 0;
            ts.digest = undefined;
            ts.sourceCountBefore = undefined;
            ts.identityStart = undefined;
            ts.indexesCreated = undefined;
            if (snapshotOn) freshInSnapshot.add(tp.sourceTable);
          }
        }
        if (!ts.stagingCreated) {
          if (tp.identity) {
            const srcCol = tp.columns.find((c) => c.target.name === tp.identity!.column)!.source.name;
            ts.identityStart = identityStartFrom(await ctx.src.maxValue(tp.sourceTable, srcCol));
          }
          const { info, opts: ddl } = stagingDdl(ctx, tp, ts, run);
          await ctx.tgt.createTable(info, ddl);
          ts.stagingCreated = true;
          ev.append("staging_created", { table: tp.sourceTable, staging: ts.stagingTable, identityStart: ts.identityStart });
        }
        ts.status = "staging";
        ts.sourceCountBefore ??= await ctx.src.countRows(tp.sourceTable);
        const digest = ts.digest ? TableDigest.restore(targetColumns(tp), ts.digest) : new TableDigest(targetColumns(tp));
        const stage = targetInfo(tp, ts.stagingTable);
        const names = targetColumns(tp).map((c) => c.name);
        ctx.store.saveRun(run);

        const reader = prefetch(ctx.src.readRows(tp.sourceTable, { columns: sourceNames(tp), batchSize, cursor: ts.cursor }), opts.prefetch ?? 2);
        for await (const b of reader) {
          const rows: unknown[][] = [];
          for (const r of b.rows) {
            const v = transformRow(r, tp, ctx.tgt, ts.rowsRead + rows.length + 1);
            if (!v) throw new Error(`Row ${ts.rowsRead + rows.length + 1} of ${tp.sourceTable} no longer passes validation (source data changed since the dry run). Run dry_run again.`);
            rows.push(v);
          }
          await ctx.tgt.insertRows(stage, names, rows);
          for (const r of rows) digest.add(r);
          ts.rowsRead += b.rows.length;
          ts.rowsLoaded += rows.length;
          ts.cursor = b.cursor;
          ts.digest = digest.export();
          ctx.store.saveRun(run);
          if (++batches >= budget) throw new StopForBudget();
        }
        ts.digest = digest.export(); // also covers empty tables, which never enter the batch loop

        if (freshInSnapshot.has(tp.sourceTable)) {
          // counted and read inside the same snapshot: they must agree exactly. Later drift is reported after the snapshot ends.
          if (ts.rowsRead !== ts.sourceCountBefore)
            throw new Error(`Read ${ts.rowsRead} rows of ${tp.sourceTable} but the snapshot holds ${ts.sourceCountBefore}.`);
        } else {
          ts.sourceCountAfter = await ctx.src.countRows(tp.sourceTable);
          if (ts.rowsRead !== ts.sourceCountBefore || ts.sourceCountBefore !== ts.sourceCountAfter)
            throw new Error(
              `Row count unstable for ${tp.sourceTable}: ${ts.sourceCountBefore} before, ${ts.rowsRead} read, ${ts.sourceCountAfter} after. The source changed during the copy; use a source that supports snapshots, or migrate from a replica.`,
            );
        }

        if (tp.identity && ts.identityStart) {
          const m = await ctx.tgt.maxValue(ts.stagingTable, tp.identity.column);
          if (m !== null && BigInt(identityStartFrom(m)) > BigInt(ts.identityStart))
            throw new Error(`The auto-generated column "${tp.identity.column}" in ${tp.sourceTable} now holds values above where it was set to continue (${ts.identityStart}); the source changed. Run again.`);
        }

        // indexes after the load (faster); a failure here costs an index, never data, so it is reported rather than fatal
        if (ctx.tgt.supportsIndexes && run.mode !== "append") {
          ts.indexesCreated ??= [];
          for (const ix of tp.indexes) {
            if (ts.indexesCreated.includes(ix.name)) continue;
            try {
              await ctx.tgt.createIndex(ts.stagingTable, ix);
              ts.indexesCreated.push(ix.name);
              ev.append("index_created", { table: tp.targetTable, index: ix.name, columns: ix.columns, unique: ix.unique });
            } catch (e) {
              const error = scrub(String((e as Error).message ?? e), ctx.config);
              if (!run.constraintFailures.some((f) => f.table === tp.targetTable && f.name === ix.name))
                run.constraintFailures.push({
                  table: tp.targetTable,
                  name: ix.name,
                  sql: `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${ix.name} ON ${tp.targetTable} (${ix.columns.join(", ")})`,
                  error,
                });
              ev.append("index_failed", { table: tp.targetTable, index: ix.name, error });
            }
            ctx.store.saveRun(run);
          }
        }
        ts.status = "staged";
        ev.append("table_staged", { table: tp.sourceTable, rows: ts.rowsLoaded, digest: digest.result() });
        ctx.store.saveRun(run);
      } catch (e) {
        if (e instanceof StopForBudget) {
          run.status = "partial";
          ev.append("run_paused", { table: tp.sourceTable, rowsLoaded: ts.rowsLoaded });
          ctx.store.saveRun(run);
          return run;
        }
        return fail(ts, e);
      }
    }
    return undefined;
  };
  let early: RunState | undefined;
  try {
    early = await stageAll();
  } finally {
    if (snapshotOn) {
      try {
        await ctx.src.endSnapshot();
      } catch {
        /* the connection is closed by the caller */
      }
    }
  }
  if (early) return early;

  // after the snapshot: did the source move on while we copied? That is information, not an error.
  for (const ts of run.tables) {
    if (!freshInSnapshot.has(ts.sourceTable) || ts.sourceCountAfter !== undefined || ts.status !== "staged") continue;
    try {
      ts.sourceCountAfter = await ctx.src.countRows(ts.sourceTable);
      if (ts.sourceCountAfter !== ts.sourceCountBefore)
        run.warnings.push(`${ts.sourceTable} has ${ts.sourceCountAfter} rows now; the migrated copy is the consistent snapshot of ${ts.sourceCountBefore}. Run reconcile to see the drift.`);
    } catch {
      /* informational only */
    }
  }
  ctx.store.saveRun(run);

  // ---- phase 2: verify every staged table by reading it back
  for (const tp of plan.tables) {
    const ts = run.tables.find((t) => t.sourceTable === tp.sourceTable)!;
    if (ts.status === "verified" || ts.status === "promoted") continue;
    try {
      const expected = TableDigest.restore(targetColumns(tp), ts.digest!);
      const got = await targetDigest(ctx, ts.stagingTable, tp, batchSize);
      const v = compare(expected, got.digest, got.failed);
      let dupes = 0;
      if (tp.createPrimaryKey && !ctx.tgt.enforcesPrimaryKey) dupes = await ctx.tgt.countDuplicateKeys(ts.stagingTable, tp.primaryKey);
      ts.verify = { ...v, ok: v.ok && dupes === 0 };
      ev.append("table_verified", { table: tp.sourceTable, ...ts.verify, duplicateKeys: dupes });
      if (!ts.verify.ok) {
        const why = dupes
          ? `${dupes} duplicate primary-key value(s) in the staged data`
          : `staged data differs from source: rows ${v.sourceRows} vs ${v.targetRows}, mismatched columns [${v.mismatchedColumns.join(", ")}]`;
        throw new Error(`Verification failed for ${tp.sourceTable}: ${why}. Nothing was promoted.`);
      }
      ts.status = "verified";
      ctx.store.saveRun(run);
    } catch (e) {
      return fail(ts, e);
    }
  }

  // ---- phase 3: promote
  if (mode === "append") {
    const appended: TableRunState[] = [];
    try {
      // check every key first so a collision stops the run before anything is written
      for (const tp of plan.tables) {
        const ts = run.tables.find((t) => t.sourceTable === tp.sourceTable)!;
        if (ts.status === "promoted" || !tp.appendKey?.length) continue;
        const n = await ctx.tgt.countKeyCollisions(ts.stagingTable, tp.targetTable, tp.appendKey);
        ev.append("collision_check", { table: tp.targetTable, key: tp.appendKey, collisions: n });
        if (n > 0)
          throw new Error(`${n} row(s) of ${tp.sourceTable} have keys that already exist in "${tp.targetTable}". Nothing was appended.`);
      }
      for (const tp of plan.tables) {
        const ts = run.tables.find((t) => t.sourceTable === tp.sourceTable)!;
        if (ts.status === "promoted") continue;
        ts.targetCountBefore = await ctx.tgt.countRows(tp.targetTable);
        await ctx.tgt.insertFromTable(ts.stagingTable, tp.targetTable, targetColumns(tp).map((c) => c.name));
        appended.push(ts);
        const idCol = tp.existingTarget?.identity;
        if (idCol && ctx.tgt.syncIdentity && tp.columns.some((c) => c.target.name === idCol)) {
          try {
            await ctx.tgt.syncIdentity(tp.targetTable, idCol);
            ev.append("identity_synced", { table: tp.targetTable, column: idCol });
          } catch (e) {
            run.warnings.push(`Could not move the counter of ${tp.targetTable}.${idCol} past the appended rows (${scrub(String((e as Error).message ?? e), ctx.config)}); reset it by hand.`);
          }
        }
        const after = await ctx.tgt.countRows(tp.targetTable);
        if (after !== ts.targetCountBefore + ts.rowsLoaded)
          run.warnings.push(`${tp.targetTable}: expected ${ts.targetCountBefore + ts.rowsLoaded} rows after the append but found ${after}. Something else may be writing to it.`);
        if (ts.targetCountBefore === 0) {
          // the table was empty, so the whole table is exactly our rows and can be digested
          const got = await targetDigest(ctx, tp.targetTable, tp, batchSize);
          const v = compare(TableDigest.restore(targetColumns(tp), ts.digest!), got.digest, got.failed);
          if (!v.ok) throw new Error(`After appending, ${tp.targetTable} does not match the source (rows ${v.sourceRows} vs ${v.targetRows}, columns [${v.mismatchedColumns.join(", ")}]).`);
        }
        ts.status = "promoted";
        ev.append("table_appended", { table: ts.sourceTable, target: ts.targetTable, rows: ts.rowsLoaded, rowsBefore: ts.targetCountBefore, rowsAfter: after, fullDigestChecked: ts.targetCountBefore === 0 });
        ctx.store.saveRun(run);
      }
    } catch (e) {
      for (const ts of appended.reverse()) {
        const tp = plan.tables.find((t) => t.sourceTable === ts.sourceTable)!;
        try {
          if (tp.appendKey?.length) {
            await ctx.tgt.deleteMatchingKeys(ts.targetTable, ts.stagingTable, tp.appendKey);
            ts.status = "verified";
          } else run.warnings.push(`Could not remove the rows appended to ${ts.targetTable}: it has no key.`);
        } catch {
          run.warnings.push(`Could not remove the rows appended to ${ts.targetTable}; run rollback.`);
        }
      }
      return fail(undefined, e);
    }
  } else {
    const promoted: TableRunState[] = [];
    let current: TableRunState | undefined;
    try {
      for (const ts of run.tables) {
        if (ts.status === "promoted") continue;
        current = ts;
        const exists = await ctx.tgt.tableExists(ts.targetTable);
        if (exists && mode === "create") throw new Error(`Target table "${ts.targetTable}" appeared while the run was in progress. Nothing was replaced.`);
        if (exists) {
          ts.backupTable = backupName(run.id, ts.targetTable);
          await ctx.tgt.renameTable(ts.targetTable, ts.backupTable);
          ev.append("table_backed_up", { table: ts.targetTable, backup: ts.backupTable });
        }
        await ctx.tgt.renameTable(ts.stagingTable, ts.targetTable);
        ts.status = "promoted";
        promoted.push(ts);
        ev.append("table_promoted", { table: ts.sourceTable, target: ts.targetTable, rows: ts.rowsLoaded, backup: ts.backupTable });
        ctx.store.saveRun(run);
      }
    } catch (e) {
      const undo = async (ts: TableRunState, movedStaging: boolean) => {
        try {
          if (movedStaging) await ctx.tgt.renameTable(ts.targetTable, ts.stagingTable);
          if (ts.backupTable) await ctx.tgt.renameTable(ts.backupTable, ts.targetTable);
          ts.backupTable = undefined;
          ts.status = "verified";
        } catch {
          run.warnings.push(`Could not undo promotion of ${ts.targetTable}; run rollback.`);
        }
      };
      if (current && current.status !== "promoted" && current.backupTable) await undo(current, false);
      for (const ts of promoted.reverse()) await undo(ts, true);
      return fail(undefined, e);
    }

    // foreign keys last, once every table they might point at is in place; a failure costs a constraint, never data
    if (ctx.tgt.foreignKeyMode === "alter") {
      for (const tp of plan.tables) {
        for (const fk of tp.foreignKeys) {
          try {
            await ctx.tgt.addForeignKey(tp.targetTable, fk);
            run.foreignKeys.push({ table: tp.targetTable, name: fk.name });
            ev.append("foreign_key_added", { table: tp.targetTable, name: fk.name });
          } catch (e) {
            const error = scrub(String((e as Error).message ?? e), ctx.config);
            run.constraintFailures.push({ table: tp.targetTable, name: fk.name, sql: ctx.tgt.foreignKeySql?.(tp.targetTable, fk) ?? `FOREIGN KEY ${fk.name} on ${tp.targetTable}`, error });
            ev.append("foreign_key_failed", { table: tp.targetTable, name: fk.name, error });
          }
          ctx.store.saveRun(run);
        }
      }
    }
  }

  if (run.constraintFailures.length)
    run.warnings.push(`${run.constraintFailures.length} index(es) or foreign key(s) could not be created. The data is verified and in place; see constraintFailures for the statements to run by hand.`);
  if (mode === "replace" && run.tables.some((t) => t.backupTable))
    run.warnings.push("The replaced tables are kept as backups. Call finalize_run to drop them once you are satisfied, or rollback to restore them.");
  if (mode === "append")
    run.warnings.push("The staging tables are kept so the append can be undone by key. Call finalize_run to drop them.");
  run.status = "succeeded";
  ev.append("run_succeeded", { mode, tables: run.tables.map((t) => ({ table: t.targetTable, rows: t.rowsLoaded })), constraintFailures: run.constraintFailures.length });
  ctx.store.saveRun(run);
  return run;
}

// ------------------------------------------------------------------ rollback and finalize

/** Undo a run: staging tables go, new tables go and backups come back, appended rows are deleted by key. */
export async function rollbackRun(ctx: Ctx, runId: string): Promise<RunState> {
  const run = ctx.store.loadRun(runId);
  if (ctx.tgt.readOnly) throw new Error("Target connection is marked readOnly.");
  if (run.finalized) throw new Error("This run was finalized: the backups and staging tables it needed are gone, so it can no longer be rolled back.");
  const ev = new EvidenceLog(ctx.store.evidenceFile(run.id));
  if (run.mode === "append" && !run.rollbackable && run.tables.some((t) => t.status === "promoted" && !t.appendKey?.length))
    throw new Error("Some tables were appended without a key, so their rows cannot be told apart from existing ones and cannot be removed. Nothing was changed.");

  // constraints this run added go first, so they cannot block dropping the tables they sit on
  for (const fk of [...run.foreignKeys].reverse()) {
    try {
      if (await ctx.tgt.tableExists(fk.table)) await ctx.tgt.dropForeignKey(fk.table, fk.name);
    } catch {
      /* the table is dropped below anyway */
    }
  }
  run.foreignKeys = [];

  for (const ts of [...run.tables].reverse()) {
    const done: string[] = [];
    if (ts.status === "promoted") {
      if (run.mode === "append") {
        if (ts.appendKey?.length && (await ctx.tgt.tableExists(ts.stagingTable))) {
          await ctx.tgt.deleteMatchingKeys(ts.targetTable, ts.stagingTable, ts.appendKey);
          done.push(`removed appended rows from ${ts.targetTable}`);
        }
      } else if (await ctx.tgt.tableExists(ts.targetTable)) {
        await ctx.tgt.dropTable(ts.targetTable);
        done.push(`dropped ${ts.targetTable}`);
      }
    }
    // a promotion that stopped halfway can leave the old table parked as a backup with nothing in its place
    if (run.mode === "replace" && ts.backupTable && (await ctx.tgt.tableExists(ts.backupTable)) && !(await ctx.tgt.tableExists(ts.targetTable))) {
      await ctx.tgt.renameTable(ts.backupTable, ts.targetTable);
      done.push(`restored ${ts.targetTable} from ${ts.backupTable}`);
      ts.backupTable = undefined;
    }
    if (ts.stagingCreated && (await ctx.tgt.tableExists(ts.stagingTable))) {
      await ctx.tgt.dropTable(ts.stagingTable);
      done.push(`dropped ${ts.stagingTable}`);
    }
    ts.status = "rolled_back";
    ev.append("table_rolled_back", { table: ts.sourceTable, actions: done });
  }
  run.status = "rolled_back";
  ev.append("run_rolled_back", { runId });
  ctx.store.saveRun(run);
  return run;
}

/** Make a succeeded run permanent: drop replace backups and append staging tables. Rollback is no longer possible afterwards. */
export async function finalizeRun(ctx: Ctx, runId: string): Promise<RunState> {
  const run = ctx.store.loadRun(runId);
  if (run.status !== "succeeded") throw new Error(`Only a succeeded run can be finalized; this one is ${run.status}.`);
  if (run.finalized) throw new Error("This run is already finalized.");
  if (ctx.tgt.readOnly) throw new Error("Target connection is marked readOnly.");
  const ev = new EvidenceLog(ctx.store.evidenceFile(run.id));
  const dropped: string[] = [];
  // Backups can reference each other (old orders -> old customers), so a drop may have to wait for another.
  let pending = run.tables.flatMap((ts) => [ts.backupTable, run.mode === "append" ? ts.stagingTable : undefined]).filter((n): n is string => !!n);
  let lastError: unknown;
  while (pending.length) {
    const left: string[] = [];
    for (const name of pending) {
      try {
        if (await ctx.tgt.tableExists(name)) await ctx.tgt.dropTable(name);
        dropped.push(name);
      } catch (e) {
        lastError = e;
        left.push(name);
      }
    }
    if (left.length === pending.length)
      throw new Error(`Could not drop ${left.join(", ")}: ${scrub(String((lastError as Error)?.message ?? lastError), ctx.config)}. Nothing else was changed; the run is not finalized.`);
    pending = left;
  }
  for (const ts of run.tables) ts.backupTable = undefined;
  run.finalized = true;
  run.rollbackable = false;
  run.warnings = run.warnings.filter((w) => !/finalize_run/.test(w));
  ev.append("run_finalized", { dropped });
  ctx.store.saveRun(run);
  return run;
}
