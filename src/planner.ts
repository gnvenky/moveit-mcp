import { randomBytes } from "node:crypto";
import { sha256Hex, stableStringify } from "./canonical.js";
import { fitDefault } from "./adapters/defaults.js";
import type {
  Adapter,
  CanonicalType,
  ColumnInfo,
  ColumnPlan,
  ForeignKeyInfo,
  IndexInfo,
  Issue,
  MigrationMode,
  ObjectInventory,
  Plan,
  TableExtras,
  TableInfo,
  TableOverride,
  TablePlan,
} from "./types.js";

export interface PlanOptions {
  source: string;
  target: string;
  tables?: string[];
  overrides?: TableOverride[];
  /** "convention" renames to the target's style (lower/UPPER, snake_case). Default: preserve when source and target are the same kind. */
  naming?: "convention" | "preserve";
  /** create (default): new tables only. replace: swap in new tables, keep the old ones until finalize. append: add rows to existing tables. */
  mode?: MigrationMode;
  /** Carry over indexes, foreign keys, defaults and identity columns. All default to true; set false to leave one out. */
  objects?: { indexes?: boolean; foreignKeys?: boolean; defaults?: boolean; identity?: boolean };
}

export const STAGING_PREFIX = "_moveit_";
const UNBOUNDED_IN_PK: CanonicalType[] = ["text", "json", "binary", "unknown"];

export function stagingName(runId: string, target: string): string {
  return `${STAGING_PREFIX}${runId.replace(/^run_/, "")}_${target}`;
}

function fitName(name: string, max: number): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 7)}_${sha256Hex(name).slice(0, 6)}`;
}

/** Primary-key constraint name. `salt` keeps it unique when an older table with the same key name is still around. */
export function pkNameFor(table: string, max: number, salt?: string): string {
  return fitName(salt ? `pk_${table}_${salt}` : `pk_${table}`, max);
}

export function backupName(runId: string, target: string): string {
  return `${STAGING_PREFIX}${runId.replace(/^run_/, "")}_bak_${target}`;
}

/** A name that is not in `taken` (case-insensitive), recording it there. */
function uniqueName(base: string, taken: Set<string>, max: number, prefix: string): string {
  const tryName = (n: string): string | undefined => {
    const f = fitName(n, max);
    return taken.has(f.toLowerCase()) ? undefined : f;
  };
  let name = tryName(base) ?? tryName(`${prefix}_${base}`);
  for (let i = 2; !name; i++) name = tryName(`${prefix}_${base}_${i}`);
  taken.add(name.toLowerCase());
  return name;
}

const NOT_INDEXABLE: CanonicalType[] = ["text", "json", "binary", "unknown"];

/** Lowest value a new identity column should hand out, given the highest existing one. */
export function identityStartFrom(max: string | null): string {
  if (max === null) return "1";
  const m = /^(-?\d+)(\.0+)?$/.exec(max.trim());
  if (!m) throw new Error(`Cannot continue an identity column from "${max}".`);
  const next = BigInt(m[1]) + 1n;
  return (next < 1n ? 1n : next).toString();
}

function mapColumn(src: ColumnInfo, tgt: Adapter, table: string, name: string, ov: TableOverride | undefined, issues: Issue[]): ColumnInfo {
  const o = ov?.typeOverrides?.[src.name];
  let type: CanonicalType = o?.type ?? src.type;
  let length = o ? o.length : src.length;
  let precision = o ? o.precision : src.precision;
  let scale = o ? o.scale : src.scale;
  const issue = (severity: Issue["severity"], code: string, message: string) =>
    issues.push({ severity, code, table, column: src.name, message });

  if (o) issue("info", "type_override", `Type overridden to ${o.type}.`);
  if (type !== "string") length = undefined;
  if (type !== "decimal") {
    precision = undefined;
    scale = undefined;
  }

  if (type === "decimal") {
    if (precision === undefined) {
      if (tgt.defaultDecimal) {
        precision = tgt.defaultDecimal.precision;
        scale = tgt.defaultDecimal.scale;
        issue(
          "warn",
          "unbounded_decimal",
          `Source numeric has no declared precision; ${tgt.label} needs one, using DECIMAL(${precision},${scale}). The dry run checks every value fits.`,
        );
      }
    } else if (precision > tgt.maxDecimalPrecision) {
      issue(
        "warn",
        "decimal_precision_clamped",
        `Precision ${precision} exceeds ${tgt.label}'s maximum of ${tgt.maxDecimalPrecision}; clamped. The dry run checks every value fits.`,
      );
      precision = tgt.maxDecimalPrecision;
      scale = Math.min(scale ?? 0, precision);
    }
  }
  if (type === "unknown")
    issue(
      "warn",
      "unmapped_type",
      `Native type "${src.nativeType}" has no canonical mapping; values will be copied as text. Use typeOverrides or exclude the column.`,
    );
  if (type === "time" && tgt.kind === "oracle")
    issue("info", "time_as_text", "Oracle has no TIME type; stored as VARCHAR2(15).");
  if (type === "time" && tgt.kind === "databricks")
    issue("info", "time_as_text", "Databricks has no TIME type; stored as STRING.");
  if (tgt.kind === "databricks" && type === "string" && length !== undefined)
    issue("info", "length_not_enforced", "Databricks STRING does not enforce a maximum length.");
  if (tgt.kind === "mysql" && type === "timestamptz")
    issue("info", "tz_normalised", "MySQL has no timestamp-with-zone; values are stored as UTC DATETIME(6).");
  if (tgt.kind === "sqlite" && type === "decimal" && (precision === undefined || precision > 15))
    issue(
      "warn",
      "sqlite_decimal_precision",
      "SQLite stores numbers as 64-bit floats, so values beyond ~15 significant digits cannot be stored exactly; verification will fail if any do. Use a text type override for exact values.",
    );
  if (tgt.kind === "sqlite" || tgt.kind === "csv")
    if (type === "json" || type === "decimal")
      issue("info", "weak_typing", `${tgt.label} stores ${type} loosely; values round-trip exactly but are not type-enforced.`);

  return { name, nativeType: `(${type})`, type, nullable: src.nullable, length, precision, scale };
}

/** Foreign keys in the target database that point at `table` from other tables. */
async function incomingForeignKeys(tgt: Adapter, table: string, replacedToo: Set<string>): Promise<{ from: string[]; complete: boolean }> {
  const from: string[] = [];
  let complete = true;
  // tables swapped in this same plan take their old foreign keys with them into the backup
  const names = (await tgt.listTables()).filter((n) => !n.startsWith(STAGING_PREFIX) && n !== table && !replacedToo.has(n));
  if (names.length > 500) return { from, complete: false };
  for (const n of names) {
    try {
      const ex = await tgt.describeExtras(n);
      if (ex.foreignKeys.some((f) => f.refTable === table)) from.push(n);
    } catch {
      complete = false;
    }
  }
  return { from, complete };
}

export async function buildPlan(src: Adapter, tgt: Adapter, opts: PlanOptions): Promise<Plan> {
  const mode: MigrationMode = opts.mode ?? "create";
  const want = { indexes: true, foreignKeys: true, defaults: true, identity: true, ...opts.objects };
  const available = (await src.listTables()).filter((t) => !t.startsWith(STAGING_PREFIX));
  const chosen = opts.tables?.length ? opts.tables : available;
  for (const t of chosen)
    if (!available.includes(t))
      throw new Error(`Table "${t}" not found in source "${opts.source}". Available: ${available.join(", ") || "(none)"}`);
  const preserve = (opts.naming ?? (src.kind === tgt.kind ? "preserve" : "convention")) === "preserve";
  const norm = (n: string) => (preserve ? n : tgt.normalizeIdentifier(n));

  const planIssues: Issue[] = [];
  const allTargets = new Set(chosen.map((t) => opts.overrides?.find((o) => o.source === t)?.target ?? norm(t)));
  if (mode === "append" && tgt.kind === "csv")
    planIssues.push({ severity: "error", code: "mode_unsupported", message: "CSV targets support create and replace, not append." });

  const tables: TablePlan[] = [];
  const seenTargets = new Map<string, string>();
  const max = tgt.maxIdentifierLength;
  const takenIndexNames = new Set<string>();
  const takenFkNames = new Set<string>();
  const extrasBySource = new Map<string, TableExtras>();
  const targetInfoBySource = new Map<string, TableInfo>();

  for (const t of chosen) {
    const info: TableInfo = await src.describeTable(t);
    const ov = opts.overrides?.find((o) => o.source === t);
    const issues: Issue[] = [];
    const add = (severity: Issue["severity"], code: string, message: string, column?: string) =>
      issues.push({ severity, code, table: t, column, message });

    for (const e of ov?.exclude ?? [])
      if (!info.columns.some((c) => c.name === e)) add("error", "unknown_column", `exclude: column "${e}" does not exist.`, e);
    for (const k of Object.keys(ov?.renames ?? {}))
      if (!info.columns.some((c) => c.name === k)) add("error", "unknown_column", `renames: column "${k}" does not exist.`, k);
    for (const k of Object.keys(ov?.typeOverrides ?? {}))
      if (!info.columns.some((c) => c.name === k)) add("error", "unknown_column", `typeOverrides: column "${k}" does not exist.`, k);

    const targetTable = ov?.target ?? norm(t);
    const prior = seenTargets.get(targetTable);
    if (prior) add("error", "target_collision", `Target table "${targetTable}" is also the target of "${prior}".`);
    seenTargets.set(targetTable, t);

    const longest = mode === "replace" ? backupName("run_00000000", targetTable) : stagingName("run_00000000", targetTable);
    if (longest.length > max)
      add("error", "identifier_too_long", `Target table name "${targetTable}" is too long for ${mode === "replace" ? "its backup" : "staging"} on ${tgt.label} (limit ${max}). Set a shorter "target" override.`);
    if (targetTable.length > max)
      add("error", "identifier_too_long", `Target table name "${targetTable}" exceeds ${tgt.label}'s ${max}-character limit.`);
    if (tgt.isReservedWord(targetTable)) add("info", "reserved_word", `"${targetTable}" is a reserved word on some systems; it will always be quoted.`);

    // ---- what exists in the target already
    const exists = await tgt.tableExists(targetTable);
    let existing: TableInfo | undefined;
    let existingExtras: TableExtras | undefined;
    if (mode === "create" && exists)
      add("error", "target_exists", `Target table "${targetTable}" already exists. Use mode "replace" to swap it (the old table is kept until you finalize) or "append" to add rows, or choose another name with a "target" override.`);
    if (mode === "append" && !exists)
      add("error", "target_missing", `Target table "${targetTable}" does not exist, so there is nothing to append to. Use mode "create".`);
    if (mode !== "create" && exists) {
      existing = await tgt.describeTable(targetTable);
      try {
        existingExtras = await tgt.describeExtras(targetTable);
      } catch {
        /* best effort */
      }
    }
    if (mode === "replace" && exists) {
      add("info", "replace_backup", `Existing "${targetTable}" is renamed to a backup and kept until finalize_run. Grants, views and triggers that depended on the old table are not carried over.`);
      const inc = await incomingForeignKeys(tgt, targetTable, allTargets);
      if (inc.from.length)
        add("error", "replace_referenced", `Table "${targetTable}" is referenced by foreign keys from ${inc.from.join(", ")}. Replacing it would leave them pointing at the old table. Use mode "append", or drop those constraints first.`);
      else if (!inc.complete) add("warn", "replace_fk_check_incomplete", `Could not check every table in the target for foreign keys that reference "${targetTable}". Check by hand before running.`);
    }

    // ---- columns
    const excluded = new Set(ov?.exclude ?? []);
    const columns: ColumnPlan[] = [];
    const usedNames = new Map<string, string>();
    for (const c of info.columns) {
      if (excluded.has(c.name)) continue;
      const name = ov?.renames?.[c.name] ?? norm(c.name);
      if (usedNames.has(name))
        add("error", "column_collision", `Columns "${usedNames.get(name)}" and "${c.name}" both map to "${name}".`, c.name);
      usedNames.set(name, c.name);
      if (name.length > max) add("error", "identifier_too_long", `Column name "${name}" exceeds ${tgt.label}'s ${max}-character limit.`, c.name);
      if (tgt.isReservedWord(name)) add("info", "reserved_word", `Column "${name}" is a reserved word on some systems; it will always be quoted.`, c.name);
      columns.push({ source: c, target: mapColumn(c, tgt, t, name, ov, issues) });
    }
    if (columns.length === 0) add("error", "no_columns", "All columns are excluded.");
    const tgtName = (srcCol: string) => columns.find((c) => c.source.name === srcCol)?.target.name;

    // ---- primary key
    const srcPk = ov?.primaryKey ?? info.primaryKey;
    for (const k of ov?.primaryKey ?? [])
      if (!info.columns.some((c) => c.name === k)) add("error", "unknown_column", `primaryKey: column "${k}" does not exist.`, k);
    let primaryKey: string[] = [];
    if (srcPk.length) {
      const mapped = srcPk.map((k) => columns.find((c) => c.source.name === k));
      if (mapped.some((m) => !m)) add("warn", "pk_dropped", "A primary-key column is excluded or missing; no primary key will be created.");
      else primaryKey = mapped.map((m) => m!.target.name);
    } else add("info", "no_primary_key", "No primary key. Verification still covers every row, but reads are paged by offset.");

    const createPrimaryKey = tgt.supportsPrimaryKey && primaryKey.length > 0;
    if (primaryKey.length && !tgt.supportsPrimaryKey)
      add("info", "pk_unsupported", `${tgt.label} has no primary keys; the key is recorded in the plan only.`);
    if (createPrimaryKey) {
      if (!tgt.enforcesPrimaryKey)
        add("info", "pk_not_enforced", `${tgt.label} does not enforce primary keys; duplicates are checked after staging instead.`);
      for (const k of primaryKey) {
        const col = columns.find((c) => c.target.name === k)!.target;
        if (UNBOUNDED_IN_PK.includes(col.type) || (col.type === "string" && col.length === undefined))
          add("warn", "pk_unbounded_type", `Primary-key column "${k}" is an unbounded ${col.type}; ${tgt.label} will use a bounded VARCHAR, and longer values fail the load.`, k);
      }
    }

    // ---- append: compatibility with the table that is already there, and a key to detect collisions
    let appendKey: string[] | undefined;
    if (mode === "append" && existing) {
      const have = new Map(existing.columns.map((c) => [c.name, c]));
      for (const c of columns) {
        const e = have.get(c.target.name);
        if (!e) {
          add("error", "append_missing_column", `Column "${c.target.name}" does not exist in the existing table "${targetTable}".`, c.target.name);
          continue;
        }
        if (e.type !== c.target.type && e.type !== "unknown")
          add("warn", "append_type_mismatch", `Column "${c.target.name}" is ${c.target.type} here but ${e.type} (${e.nativeType}) in the existing table; the database will convert on insert.`, c.target.name);
        if (c.target.type === "string" && c.target.length !== undefined && e.length !== undefined && c.target.length > e.length)
          add("warn", "append_length", `Column "${c.target.name}" allows ${c.target.length} characters here but ${e.length} in the existing table; longer values will fail the insert.`, c.target.name);
      }
      const planned = new Set(columns.map((c) => c.target.name));
      for (const e of existing.columns) {
        if (planned.has(e.name) || e.nullable) continue;
        const hasDefault = existingExtras?.defaults[e.name] !== undefined || existingExtras?.identity === e.name;
        if (!hasDefault)
          add("error", "append_unfilled_column", `Existing column "${e.name}" is NOT NULL with no known default, and is not part of this migration.`, e.name);
      }
      const idCol = existingExtras?.identity;
      if (idCol && planned.has(idCol) && typeof tgt.syncIdentity !== "function")
        add("warn", "append_identity", `"${idCol}" is auto-generated in the existing table. Appending explicit values does not move its counter on ${tgt.label}; reset it after the append or new rows will collide.`, idCol);
      if (primaryKey.length) appendKey = primaryKey;
      else if (existing.primaryKey.length && existing.primaryKey.every((k) => planned.has(k))) appendKey = existing.primaryKey;
      if (!appendKey)
        add("warn", "append_no_key", "No key to tell rows apart: duplicates cannot be detected before appending, and this run cannot be rolled back afterwards.");
    }

    // ---- defaults, identity, indexes (extras read from the source)
    let extras: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    try {
      extras = await src.describeExtras(t);
    } catch (e) {
      add("warn", "extras_unreadable", `Could not read indexes, defaults and keys from the source (${String((e as Error).message ?? e).slice(0, 120)}); only columns and the primary key are migrated.`);
    }
    extrasBySource.set(t, extras);
    for (const note of extras.notes) add("info", "not_migrated", note);

    if (Object.keys(extras.defaults).length && (!want.defaults || !tgt.supportsDefaults))
      add("info", "defaults_skipped", `${Object.keys(extras.defaults).length} column default(s) were not migrated (${!want.defaults ? "turned off" : `not supported by ${tgt.label} here`}).`);
    else if (want.defaults && mode !== "append")
      for (const [srcCol, d] of Object.entries(extras.defaults)) {
        const col = columns.find((c) => c.source.name === srcCol);
        if (!col) continue;
        const mysqlNoDefault = tgt.kind === "mysql" && (col.target.type === "text" || col.target.type === "unknown" || (col.target.type === "string" && col.target.length === undefined));
        const fitted = mysqlNoDefault ? undefined : fitDefault(d, col.target.type, col.target.length);
        if (fitted) col.target.default = fitted;
        else add("info", "default_skipped", `Default for "${col.target.name}" does not fit a ${col.target.type} column on ${tgt.label} and was not migrated.`, col.target.name);
      }

    let identity: TablePlan["identity"];
    if (extras.identity && mode !== "append") {
      const col = columns.find((c) => c.source.name === extras.identity);
      if (!want.identity || !tgt.supportsIdentity) add("info", "identity_skipped", `Auto-generated column "${extras.identity}" is copied as plain values (${!want.identity ? "turned off" : `${tgt.label} cannot create it here`}); new rows will need explicit keys.`);
      else if (!col) add("info", "identity_skipped", `Auto-generated column "${extras.identity}" is excluded; nothing to continue.`);
      else if (!createPrimaryKey || primaryKey.length !== 1 || primaryKey[0] !== col.target.name || (col.target.type !== "integer" && col.target.type !== "bigint"))
        add("warn", "identity_skipped", `"${extras.identity}" is auto-generated in the source but is not the single integer primary key here, so it is copied as plain values.`, col.target.name);
      else {
        let start = "1";
        try {
          start = identityStartFrom(await src.maxValue(t, extras.identity!));
        } catch {
          add("warn", "identity_start_unknown", `Could not read the highest value of "${extras.identity}" at plan time; the run will compute it.`, col.target.name);
        }
        col.target.identity = { start };
        delete col.target.default;
        identity = { column: col.target.name, start };
        add("info", "identity", `"${col.target.name}" becomes an auto-generated key continuing after the highest existing value.`, col.target.name);
      }
    }

    let indexes: IndexInfo[] = [];
    if (mode !== "append") {
      if (extras.indexes.length && (!want.indexes || !tgt.supportsIndexes))
        add("info", "indexes_skipped", `${extras.indexes.length} index(es) were not migrated (${!want.indexes ? "turned off" : `${tgt.label} has no indexes`}).`);
      else if (want.indexes) {
        for (const ix of extras.indexes) {
          const cols = ix.columns.map(tgtName);
          if (cols.some((c) => !c)) {
            add("info", "index_skipped", `Index ${ix.name} uses an excluded column and was not migrated.`);
            continue;
          }
          const names = cols as string[];
          if (ix.unique && names.length === primaryKey.length && names.every((n, i) => n === primaryKey[i])) continue; // the key already covers it
          const types = names.map((n) => columns.find((c) => c.target.name === n)!.target);
          const bad = types.find((c) => NOT_INDEXABLE.includes(c.type) || (c.type === "string" && c.length === undefined));
          if (bad && ["mysql", "oracle", "snowflake"].includes(tgt.kind)) {
            add("info", "index_skipped", `Index ${ix.name} covers "${bad.name}" (${bad.type}), which ${tgt.label} cannot index without a length; not migrated.`);
            continue;
          }
          const dup = indexes.find((o) => o.unique === ix.unique && o.columns.join() === names.join());
          if (dup) continue;
          const base = preserve ? ix.name : tgt.normalizeIdentifier(ix.name);
          const taken = new Set(takenIndexNames);
          for (const n of existingExtras?.indexes ?? []) taken.add(n.name.toLowerCase());
          const name = uniqueName(base, taken, max, targetTable);
          takenIndexNames.add(name.toLowerCase());
          indexes.push({ name, columns: names, unique: ix.unique });
        }
      }
    }

    const tableInfo: TableInfo = { name: targetTable, columns: columns.map((c) => c.target), primaryKey };
    targetInfoBySource.set(t, tableInfo);
    tables.push({
      sourceTable: t,
      targetTable,
      columns,
      excludedColumns: [...excluded],
      primaryKey,
      createPrimaryKey,
      sourceRowCount: await src.countRows(t),
      ddl: "", // filled in once every table is known (foreign keys name other tables)
      indexes,
      foreignKeys: [],
      ...(identity ? { identity } : {}),
      ...(appendKey ? { appendKey } : {}),
      ...(existing ? { existingTarget: { columns: existing.columns.map((c) => c.name), primaryKey: existing.primaryKey, ...(existingExtras?.identity ? { identity: existingExtras.identity } : {}) } } : {}),
      issues,
    });
  }

  // ---- foreign keys: need every table's target name, so they come second
  if (mode !== "append") {
    for (const tp of tables) {
      const extras = extrasBySource.get(tp.sourceTable)!;
      const add = (severity: Issue["severity"], code: string, message: string) =>
        tp.issues.push({ severity, code, table: tp.sourceTable, message });
      if (!extras.foreignKeys.length) continue;
      if (!want.foreignKeys || tgt.foreignKeyMode === "none") {
        add("info", "fks_skipped", `${extras.foreignKeys.length} foreign key(s) were not migrated (${!want.foreignKeys ? "turned off" : `${tgt.label} does not enforce them`}).`);
        continue;
      }
      for (const fk of extras.foreignKeys) {
        const ref = tables.find((o) => o.sourceTable === fk.refTable);
        const cols = fk.columns.map((c) => tp.columns.find((x) => x.source.name === c)?.target.name);
        const refCols = ref ? fk.refColumns.map((c) => ref.columns.find((x) => x.source.name === c)?.target.name) : [];
        if (!ref) add("info", "fk_skipped", `Foreign key ${fk.name} references "${fk.refTable}", which is not part of this migration; not migrated.`);
        else if (cols.some((c) => !c) || refCols.some((c) => !c)) add("info", "fk_skipped", `Foreign key ${fk.name} uses an excluded column; not migrated.`);
        else {
          const base = preserve ? fk.name : tgt.normalizeIdentifier(fk.name);
          const taken = new Set(takenFkNames);
          const name = uniqueName(base, taken, max, tp.targetTable);
          takenFkNames.add(name.toLowerCase());
          tp.foreignKeys.push({ name, columns: cols as string[], refTable: ref.targetTable, refColumns: refCols as string[], onDelete: fk.onDelete, onUpdate: fk.onUpdate });
        }
      }
    }
  }

  for (const tp of tables) {
    const info = targetInfoBySource.get(tp.sourceTable)!;
    tp.ddl = tgt.ddlFor(info, {
      withPrimaryKey: tp.createPrimaryKey,
      pkName: pkNameFor(tp.targetTable, max),
      foreignKeys: tgt.foreignKeyMode === "inline" ? tp.foreignKeys : undefined,
    });
  }

  // ---- things that exist in the source but are never migrated
  let inventory: ObjectInventory[] = [];
  try {
    inventory = await src.listObjects();
  } catch {
    planIssues.push({ severity: "info", code: "inventory_unavailable", message: "Could not list views, triggers, sequences and routines in the source." });
  }
  if (inventory.length) {
    const counts = new Map<string, number>();
    for (const o of inventory) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
    planIssues.push({
      severity: "info",
      code: "unmigrated_objects",
      message: `The source also has ${[...counts].map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ")}. These are never migrated; see "inventory" in the plan.`,
    });
  }

  const plan: Plan = {
    id: `plan_${randomBytes(5).toString("hex")}`,
    createdAt: new Date().toISOString(),
    source: opts.source,
    target: opts.target,
    sourceKind: src.kind,
    targetKind: tgt.kind,
    mode,
    tables,
    issues: [...planIssues, ...tables.flatMap((t) => t.issues)],
    inventory,
    hash: "",
  };
  plan.hash = hashPlan(plan);
  return plan;
}

export function hashPlan(plan: Plan): string {
  return sha256Hex(
    stableStringify({
      source: plan.source,
      target: plan.target,
      sourceKind: plan.sourceKind,
      targetKind: plan.targetKind,
      mode: plan.mode,
      tables: plan.tables.map((t) => ({
        s: t.sourceTable,
        t: t.targetTable,
        pk: t.primaryKey,
        cpk: t.createPrimaryKey,
        ddl: t.ddl,
        ix: t.indexes,
        fk: t.foreignKeys,
        id: t.identity,
        ak: t.appendKey,
        ex: t.existingTarget,
        cols: t.columns.map((c) => ({ s: c.source, t: c.target })),
      })),
    }),
  ).slice(0, 16);
}

export function planErrors(plan: Plan): Issue[] {
  return plan.issues.filter((i) => i.severity === "error");
}
