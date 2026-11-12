import { Connections, describeConnections, scrub, type MoveitConfig } from "./config.js";
import { EvidenceLog } from "./evidence.js";
import { buildPlan, type PlanOptions } from "./planner.js";
import { redactValue } from "./redact.js";
import { buildReport } from "./report.js";
import { dryRun, executeRun, finalizeRun, reconcile, rollbackRun, type RunOptions } from "./runner.js";
import type { Store } from "./store.js";
import type { Plan, PlanRecord, RunState } from "./types.js";

export class Moveit {
  constructor(
    readonly config: MoveitConfig,
    readonly conns: Connections,
    readonly store: Store,
  ) {}

  listConnections() {
    return describeConnections(this.config);
  }

  async testConnection(name: string) {
    const a = await this.conns.get(name);
    return { connection: name, kind: a.kind, readOnly: a.readOnly, message: await a.ping(), tables: (await a.listTables()).length };
  }

  async inspectSchema(name: string, tables?: string[]) {
    const a = await this.conns.get(name);
    const all = await a.listTables();
    const chosen = tables?.length ? tables : all;
    for (const t of chosen) if (!all.includes(t)) throw new Error(`Table "${t}" not found. Available: ${all.join(", ")}`);
    const out = [];
    for (const t of chosen) {
      const info = await a.describeTable(t);
      out.push({
        table: t,
        rows: await a.countRows(t),
        primaryKey: info.primaryKey,
        columns: info.columns.map((c) => ({
          name: c.name,
          native: c.nativeType,
          type: c.type,
          nullable: c.nullable,
          ...(c.length !== undefined ? { length: c.length } : {}),
          ...(c.precision !== undefined ? { precision: c.precision, scale: c.scale } : {}),
        })),
      });
    }
    return { connection: name, kind: a.kind, tables: out };
  }

  async sampleRows(name: string, table: string, limit = 5, redact = true) {
    const a = await this.conns.get(name);
    const info = await a.describeTable(table);
    const cols = info.columns.map((c) => c.name);
    const n = Math.min(Math.max(1, limit), 50);
    let rows: unknown[][] = [];
    for await (const b of a.readRows(table, { columns: cols, batchSize: n })) {
      rows = b.rows.slice(0, n);
      break;
    }
    return {
      table,
      redacted: redact,
      columns: cols,
      rows: rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, redactValue(c, r[i], redact)]))),
    };
  }

  async profile(name: string, table: string, sampleSize = 5000) {
    const a = await this.conns.get(name);
    const info = await a.describeTable(table);
    const cols = info.columns;
    const stats = cols.map(() => ({ nulls: 0, distinct: new Set<string>(), min: undefined as string | undefined, max: undefined as string | undefined, maxLen: 0, capped: false }));
    let n = 0;
    outer: for await (const b of a.readRows(table, { columns: cols.map((c) => c.name), batchSize: 2000 }))
      for (const r of b.rows) {
        if (n >= sampleSize) break outer;
        n++;
        r.forEach((v, i) => {
          const s = stats[i];
          if (v === null || v === undefined) return void s.nulls++;
          const str = Buffer.isBuffer(v) || v instanceof Uint8Array ? `<${(v as Uint8Array).length}b>` : String(v);
          s.maxLen = Math.max(s.maxLen, [...str].length);
          if (s.distinct.size < 10000) s.distinct.add(str);
          else s.capped = true;
          if (s.min === undefined || str < s.min) s.min = str;
          if (s.max === undefined || str > s.max) s.max = str;
        });
      }
    return {
      table,
      rowsSampled: n,
      totalRows: await a.countRows(table),
      columns: cols.map((c, i) => {
        const s = stats[i];
        return {
          name: c.name,
          type: c.type,
          nullCount: s.nulls,
          nullPct: n ? Math.round((s.nulls / n) * 1000) / 10 : 0,
          distinct: s.capped ? ">10000" : s.distinct.size,
          maxLength: s.maxLen,
          min: s.min === undefined ? null : redactValue(c.name, s.min),
          max: s.max === undefined ? null : redactValue(c.name, s.max),
          looksUnique: !s.capped && n > 0 && s.nulls === 0 && s.distinct.size === n,
        };
      }),
    };
  }

  async plan(opts: PlanOptions): Promise<PlanRecord> {
    const src = await this.conns.get(opts.source);
    const tgt = await this.conns.get(opts.target);
    const plan = await buildPlan(src, tgt, opts);
    const rec: PlanRecord = { plan };
    this.store.savePlan(rec);
    new EvidenceLog(this.store.planEvidenceFile(plan.id)).append("plan_created", {
      planId: plan.id,
      hash: plan.hash,
      source: opts.source,
      target: opts.target,
      tables: plan.tables.map((t) => ({ source: t.sourceTable, target: t.targetTable, rows: t.sourceRowCount })),
      overrides: opts.overrides ?? [],
      mode: plan.mode,
      objects: opts.objects ?? {},
    });
    return rec;
  }

  getPlan(id: string): PlanRecord {
    return this.store.loadPlan(id);
  }

  async dryRun(planId: string, opts: { maxRows?: number; showValues?: boolean } = {}) {
    const rec = this.store.loadPlan(planId);
    const src = await this.conns.get(rec.plan.source);
    const tgt = await this.conns.get(rec.plan.target);
    const result = await dryRun({ src, tgt, store: this.store, config: this.config }, rec.plan, opts);
    rec.dryRun = result;
    this.store.savePlan(rec);
    new EvidenceLog(this.store.planEvidenceFile(planId)).append("dry_run", {
      planHash: result.planHash,
      ok: result.ok,
      complete: result.complete,
      tables: result.tables.map((t) => ({ table: t.table, rows: t.rowsChecked, failed: t.rowsFailed })),
    });
    return result;
  }

  async run(planId: string, opts: RunOptions): Promise<RunState> {
    const rec = this.store.loadPlan(planId);
    const src = await this.conns.get(rec.plan.source);
    const tgt = await this.conns.get(rec.plan.target);
    return executeRun({ src, tgt, store: this.store, config: this.config }, rec, opts);
  }

  runStatus(runId: string): RunState {
    return this.store.loadRun(runId);
  }

  async reconcile(planId: string) {
    const rec = this.store.loadPlan(planId);
    const src = await this.conns.get(rec.plan.source);
    const tgt = await this.conns.get(rec.plan.target);
    return reconcile({ src, tgt, store: this.store, config: this.config }, rec.plan);
  }

  async finalize(runId: string, confirm: string): Promise<RunState> {
    if (confirm !== runId) throw new Error(`Finalize permanently drops the backups and staging tables of the run, after which it cannot be rolled back. Pass confirm="${runId}" to proceed.`);
    const run = this.store.loadRun(runId);
    const rec = this.store.loadPlan(run.planId);
    const src = await this.conns.get(rec.plan.source);
    const tgt = await this.conns.get(rec.plan.target);
    return finalizeRun({ src, tgt, store: this.store, config: this.config }, runId);
  }

  async rollback(runId: string, confirm: string): Promise<RunState> {
    if (confirm !== runId) throw new Error(`Rollback undoes what the run did to the target. Pass confirm="${runId}" to proceed.`);
    const run = this.store.loadRun(runId);
    const rec = this.store.loadPlan(run.planId);
    const src = await this.conns.get(rec.plan.source);
    const tgt = await this.conns.get(rec.plan.target);
    return rollbackRun({ src, tgt, store: this.store, config: this.config }, runId);
  }

  report(runId: string) {
    return buildReport(this.store, runId);
  }

  scrub(msg: string): string {
    return scrub(msg, this.config);
  }
}

/** Compact plan view for agents: mapping per column instead of the full internal structure. */
export function summarizePlan(plan: Plan) {
  return {
    planId: plan.id,
    planHash: plan.hash,
    source: `${plan.source} (${plan.sourceKind})`,
    target: `${plan.target} (${plan.targetKind})`,
    mode: plan.mode,
    executable: !plan.issues.some((i) => i.severity === "error"),
    issues: plan.issues.filter((i) => i.severity !== "info").concat(plan.issues.filter((i) => i.severity === "info")),
    tables: plan.tables.map((t) => ({
      source: t.sourceTable,
      target: t.targetTable,
      rows: t.sourceRowCount,
      primaryKey: t.primaryKey,
      ...(t.identity ? { identity: t.identity.column } : {}),
      ...(t.appendKey ? { appendKey: t.appendKey } : {}),
      indexes: t.indexes.map((i) => `${i.unique ? "unique " : ""}${i.name} (${i.columns.join(", ")})`),
      foreignKeys: t.foreignKeys.map((f) => `${f.name}: (${f.columns.join(", ")}) -> ${f.refTable} (${f.refColumns.join(", ")})`),
      excludedColumns: t.excludedColumns,
      columns: t.columns.map((c) => ({
        from: c.source.name,
        sourceType: c.source.nativeType,
        to: c.target.name,
        type: c.target.type,
        ...(c.target.length !== undefined ? { length: c.target.length } : {}),
        ...(c.target.precision !== undefined ? { precision: c.target.precision, scale: c.target.scale } : {}),
        nullable: c.target.nullable,
        ...(c.target.default ? { default: c.target.default } : {}),
      })),
      ddl: t.ddl,
    })),
    notMigrated: plan.inventory.map((o) => `${o.kind} ${o.name}${o.table ? ` (on ${o.table})` : ""}`),
    next: "Review issues, then call dry_run with this planId. run_migration needs the planHash above.",
  };
}
