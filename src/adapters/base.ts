import type {
  Adapter,
  Batch,
  ColumnInfo,
  ConnectionConfig,
  DbKind,
  DdlOptions,
  DefaultValue,
  ForeignKeyInfo,
  IndexInfo,
  ObjectInventory,
  ReadOptions,
  TableExtras,
  TableInfo,
} from "../types.js";

export async function lazyImport<T = any>(pkg: string): Promise<T> {
  try {
    const mod: any = await import(pkg);
    return (mod.default ?? mod) as T;
  } catch (e: any) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND")
      throw new Error(`Driver "${pkg}" is not installed. Run: npm install ${pkg}`);
    throw e;
  }
}

export function cfgStr(cfg: ConnectionConfig, key: string, required = false): string | undefined {
  const v = cfg[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`Connection config is missing "${key}"`);
    return undefined;
  }
  return String(v);
}

/** Split "NAME(10,2)" / "VARCHAR(20)" / "TIMESTAMP(6) WITH TIME ZONE" into parts. */
export function parseNativeType(raw: string): { base: string; args: number[]; full: string } {
  const full = raw.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_ ]*?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\))?(\s+.*)?$/.exec(full);
  if (!m) return { base: full.toUpperCase(), args: [], full };
  const args = [m[2], m[3]].filter((x) => x !== undefined).map(Number);
  const base = (m[1] + (m[4] ?? "")).replace(/\s+/g, " ").trim().toUpperCase();
  return { base, args, full };
}

const COMMON_RESERVED = new Set(
  (
    "add all alter and any as asc between by case check column comment constraint create default delete desc distinct drop else " +
    "end exists false for foreign from grant group having in index insert into is join key like limit not null of offset on or " +
    "order primary references select set table then to true union unique update user using values view when where with level " +
    "number date timestamp session size start type uid"
  ).split(" "),
);

/** Cursor keys are persisted as JSON, so keep them to numbers and strings. */
export function cursorKey(v: unknown): unknown {
  if (typeof v === "bigint") return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  return v;
}

export type IdentifierCase = "lower" | "upper" | "preserve";

export function normalizeIdent(name: string, mode: IdentifierCase): string {
  if (mode === "preserve") return name.trim() || "col";
  const s = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_$#]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const out = s === "" ? "col" : s;
  return mode === "lower" ? out.toLowerCase() : out.toUpperCase();
}

/**
 * Shared behaviour for SQL databases. Dialect subclasses provide connection handling,
 * quoting, type mapping and catalog queries; this class provides paging, bulk insert,
 * and DDL generation.
 */
export abstract class SqlAdapter implements Adapter {
  abstract readonly kind: DbKind;
  abstract readonly label: string;
  emptyStringIsNull = false;
  maxIdentifierLength = 63;
  supportsPrimaryKey = true;
  enforcesPrimaryKey = true;
  maxDecimalPrecision = 1000;
  defaultDecimal?: { precision: number; scale: number };
  maxStringBytes?: number;
  preferredBatchSize?: number;
  supportsIndexes = true;
  supportsDefaults = true;
  supportsIdentity = true;
  foreignKeyMode: "inline" | "alter" | "none" = "alter";
  protected identifierCase: IdentifierCase = "lower";
  /** Max bind parameters per statement. */
  protected maxParams = 30000;
  /** Whether BEGIN/COMMIT are available for batch atomicity. */
  protected transactional = true;

  constructor(protected readonly cfg: ConnectionConfig) {}

  get readOnly(): boolean {
    return this.cfg.readOnly === true;
  }

  // ---- dialect hooks -------------------------------------------------
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  /** Run a statement and return rows as arrays. */
  abstract query(sql: string, params?: unknown[]): Promise<unknown[][]>;
  /** Run a statement and return nothing. */
  abstract exec(sql: string, params?: unknown[]): Promise<void>;
  abstract quote(id: string): string;
  abstract placeholder(i: number): string; // 1-based
  abstract ddlType(col: ColumnInfo, isPrimaryKey: boolean): string;
  abstract listTables(): Promise<string[]>;
  abstract describeTable(name: string): Promise<TableInfo>;

  /** Qualification path in front of table names, e.g. ["public"]. */
  protected schemaParts(): string[] {
    return [];
  }
  protected page(limit: number, offset: number): string {
    return `LIMIT ${limit} OFFSET ${offset}`;
  }
  /** Expression used to read a column; dialects cast to text where drivers lose precision. */
  protected selectExpr(col: ColumnInfo, _index: number): string {
    return this.quote(col.name);
  }
  /** Placeholder for a value of this column in INSERT / WHERE, optionally wrapped in a cast. */
  placeholderFor(_col: ColumnInfo, i: number): string {
    return this.placeholder(i);
  }
  /** Convert a canonical value to what the driver should bind. */
  protected bind(v: unknown, _col: ColumnInfo): unknown {
    return v;
  }
  protected async begin(): Promise<void> {
    if (this.transactional) await this.exec("BEGIN");
  }
  protected async commit(): Promise<void> {
    if (this.transactional) await this.exec("COMMIT");
  }
  protected async rollback(): Promise<void> {
    if (this.transactional) await this.exec("ROLLBACK");
  }
  protected pingSql(): string {
    return "SELECT 1";
  }
  protected ddlSuffix(): string {
    return "";
  }
  protected renameSql(from: string, to: string): string {
    return `ALTER TABLE ${this.qname(from)} RENAME TO ${this.quote(to)}`;
  }
  protected dropSql(name: string): string {
    return `DROP TABLE ${this.qname(name)}`;
  }

  /** Build one multi-row INSERT. Overridden by dialects that inline literals or need SELECT form. */
  buildInsert(
    table: string,
    cols: ColumnInfo[],
    rows: unknown[][],
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const tuples = rows.map((r) => {
      const ph = cols.map((c, j) => {
        params.push(this.bind(r[j], c));
        return this.placeholderFor(c, params.length);
      });
      return `(${ph.join(", ")})`;
    });
    return {
      sql: `INSERT INTO ${this.qname(table)} (${cols.map((c) => this.quote(c.name)).join(", ")}) VALUES ${tuples.join(", ")}`,
      params,
    };
  }

  // ---- shared implementation ----------------------------------------
  qname(table: string): string {
    return [...this.schemaParts(), table].map((p) => this.quote(p)).join(".");
  }

  normalizeIdentifier(name: string): string {
    return normalizeIdent(name, this.identifierCase);
  }

  isReservedWord(name: string): boolean {
    return COMMON_RESERVED.has(name.toLowerCase());
  }

  protected assertWritable(op: string): void {
    if (this.readOnly) throw new Error(`Connection is marked readOnly; refusing to ${op}.`);
  }

  async ping(): Promise<string> {
    await this.query(this.pingSql());
    return `${this.label}: connected`;
  }

  /** What goes after FROM when reading a table; time-travel dialects add a clause while a snapshot is active. */
  protected readFrom(table: string): string {
    return this.qname(table);
  }
  protected indexNameSql(name: string): string {
    return this.quote(name);
  }

  async countRows(table: string): Promise<number> {
    const rows = await this.query(`SELECT COUNT(*) FROM ${this.readFrom(table)}`);
    return Number(rows[0][0]);
  }

  async tableExists(name: string): Promise<boolean> {
    return (await this.listTables()).includes(name);
  }

  protected orderableColumns(info: TableInfo): ColumnInfo[] {
    return info.columns.filter((c) => !["json", "binary", "text", "unknown"].includes(c.type));
  }

  async *readRows(table: string, opts: ReadOptions): AsyncGenerator<Batch> {
    const info = await this.describeTable(table);
    const from = this.readFrom(table);
    const pkName = info.primaryKey.length === 1 ? info.primaryKey[0] : undefined;
    const pkCol = pkName ? info.columns.find((c) => c.name === pkName) : undefined;
    const keyset = pkCol !== undefined && ["integer", "bigint", "string", "uuid"].includes(pkCol.type);

    const selectNames = [...opts.columns];
    let pkIdx = -1;
    if (keyset) {
      pkIdx = selectNames.indexOf(pkName!);
      if (pkIdx === -1) {
        selectNames.push(pkName!);
        pkIdx = selectNames.length - 1;
      }
    }
    const sel = selectNames
      .map((n, i) => {
        const col = info.columns.find((c) => c.name === n);
        if (!col) throw new Error(`Column ${n} not found in ${table}`);
        return this.selectExpr(col, i);
      })
      .join(", ");
    const orderCols = keyset
      ? [pkName!]
      : info.primaryKey.length
        ? info.primaryKey
        : this.orderableColumns(info).map((c) => c.name);
    const orderSql = orderCols.length ? ` ORDER BY ${orderCols.map((c) => this.quote(c)).join(", ")}` : "";

    let cursor = opts.cursor ?? { offset: 0 };
    for (;;) {
      let sql: string;
      let params: unknown[] = [];
      if (keyset) {
        let where = "";
        if (cursor.lastKey !== undefined && cursor.lastKey !== null) {
          where = ` WHERE ${this.quote(pkName!)} > ${this.placeholderFor(pkCol!, 1)}`;
          params = [this.bind(cursor.lastKey, pkCol!)];
        }
        sql = `SELECT ${sel} FROM ${from}${where}${orderSql} ${this.page(opts.batchSize, 0)}`;
      } else {
        sql = `SELECT ${sel} FROM ${from}${orderSql} ${this.page(opts.batchSize, cursor.offset)}`;
      }
      const rows = await this.query(sql, params);
      if (rows.length === 0) return;
      const next = {
        offset: cursor.offset + rows.length,
        lastKey: keyset ? cursorKey(rows[rows.length - 1][pkIdx]) : undefined,
      };
      const out = selectNames.length !== opts.columns.length ? rows.map((r) => r.slice(0, opts.columns.length)) : rows;
      cursor = next;
      yield { rows: out, cursor: next };
      if (rows.length < opts.batchSize) return;
    }
  }

  ddlFor(table: TableInfo, opts: DdlOptions = {}): string {
    const withPk = (opts.withPrimaryKey ?? true) && this.supportsPrimaryKey && table.primaryKey.length > 0;
    const pkSet = new Set(withPk ? table.primaryKey : []);
    const lines = table.columns.map((c) => {
      const notNull = !c.nullable || pkSet.has(c.name);
      return `  ${this.quote(c.name)} ${this.ddlType(c, pkSet.has(c.name))}${this.columnClause(c)}${notNull ? " NOT NULL" : ""}${this.columnTail(c)}`;
    });
    if (withPk) {
      const named = opts.pkName ? `CONSTRAINT ${this.quote(opts.pkName)} ` : "";
      lines.push(`  ${named}PRIMARY KEY (${table.primaryKey.map((c) => this.quote(c)).join(", ")})`);
    }
    if (this.foreignKeyMode === "inline")
      for (const fk of opts.foreignKeys ?? [])
        lines.push(`  CONSTRAINT ${this.quote(fk.name)} ${this.fkBody(fk)}`);
    return `CREATE TABLE ${this.qname(table.name)} (\n${lines.join(",\n")}\n)${this.ddlSuffix()}`;
  }

  // ---- defaults, identity, keys -------------------------------------
  /** Between the type and NOT NULL: DEFAULT x, or an identity clause. */
  protected columnClause(c: ColumnInfo): string {
    if (c.identity) return this.identityClause(c);
    if (c.default && this.supportsDefaults) return ` DEFAULT ${this.defaultSql(c.default)}`;
    return "";
  }
  /** After NOT NULL (MySQL's AUTO_INCREMENT). */
  protected columnTail(_c: ColumnInfo): string {
    return "";
  }
  protected identityClause(_c: ColumnInfo): string {
    return "";
  }
  protected boolLiteral(b: boolean): string {
    return b ? "TRUE" : "FALSE";
  }
  protected nowSql(): string {
    return "CURRENT_TIMESTAMP";
  }
  protected todaySql(): string {
    return "CURRENT_DATE";
  }
  protected stringLiteral(s: string): string {
    if (s.includes("\u0000")) throw new Error("NUL character in default value");
    return `'${s.replace(/'/g, "''")}'`;
  }
  protected defaultSql(d: DefaultValue): string {
    if (d.kind === "now") return this.nowSql();
    if (d.kind === "today") return this.todaySql();
    const v = d.value;
    if (typeof v === "boolean") return this.boolLiteral(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("Non-finite default value");
      return String(v);
    }
    return this.stringLiteral(v);
  }
  protected fkActionSql(fk: ForeignKeyInfo): string {
    let s = "";
    if (fk.onDelete && fk.onDelete !== "NO ACTION") s += ` ON DELETE ${fk.onDelete}`;
    if (fk.onUpdate && fk.onUpdate !== "NO ACTION") s += ` ON UPDATE ${fk.onUpdate}`;
    return s;
  }
  protected fkBody(fk: ForeignKeyInfo): string {
    const cols = fk.columns.map((c) => this.quote(c)).join(", ");
    const refs = fk.refColumns.map((c) => this.quote(c)).join(", ");
    return `FOREIGN KEY (${cols}) REFERENCES ${this.qname(fk.refTable)} (${refs})${this.fkActionSql(fk)}`;
  }

  async describeExtras(_table: string): Promise<TableExtras> {
    return { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
  }
  async listObjects(): Promise<ObjectInventory[]> {
    return [];
  }
  async maxValue(table: string, column: string): Promise<string | null> {
    const rows = await this.query(`SELECT MAX(${this.quote(column)}) FROM ${this.qname(table)}`);
    const v = rows[0]?.[0];
    return v === null || v === undefined ? null : String(v);
  }
  async createIndex(table: string, index: IndexInfo): Promise<void> {
    this.assertWritable(`create index ${index.name}`);
    await this.exec(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${this.indexNameSql(index.name)} ON ${this.qname(table)} (${index.columns.map((c) => this.quote(c)).join(", ")})`,
    );
  }
  async addForeignKey(table: string, fk: ForeignKeyInfo): Promise<void> {
    this.assertWritable(`add foreign key ${fk.name}`);
    await this.exec(`ALTER TABLE ${this.qname(table)} ADD CONSTRAINT ${this.quote(fk.name)} ${this.fkBody(fk)}`);
  }
  /** The statement addForeignKey would run, for reports when it fails. */
  foreignKeySql(table: string, fk: ForeignKeyInfo): string {
    return `ALTER TABLE ${this.qname(table)} ADD CONSTRAINT ${this.quote(fk.name)} ${this.fkBody(fk)}`;
  }
  async dropForeignKey(table: string, name: string): Promise<void> {
    this.assertWritable(`drop foreign key ${name}`);
    await this.exec(`ALTER TABLE ${this.qname(table)} DROP CONSTRAINT ${this.quote(name)}`);
  }

  async beginSnapshot(): Promise<boolean> {
    return false;
  }
  async endSnapshot(): Promise<void> {}

  async insertFromTable(from: string, to: string, columns: string[]): Promise<void> {
    this.assertWritable(`copy ${from} into ${to}`);
    const cols = columns.map((c) => this.quote(c)).join(", ");
    await this.begin();
    try {
      await this.exec(`INSERT INTO ${this.qname(to)} (${cols}) SELECT ${cols} FROM ${this.qname(from)}`);
      await this.commit();
    } catch (e) {
      try {
        await this.rollback();
      } catch {
        /* ignore secondary failure */
      }
      throw e;
    }
  }

  private keyMatch(a: string, b: string, keys: string[]): string {
    return keys.map((k) => `${this.quote(a)}.${this.quote(k)} = ${this.quote(b)}.${this.quote(k)}`).join(" AND ");
  }
  async countKeyCollisions(staging: string, target: string, keys: string[]): Promise<number> {
    const rows = await this.query(
      `SELECT COUNT(*) FROM ${this.qname(staging)} WHERE EXISTS (SELECT 1 FROM ${this.qname(target)} WHERE ${this.keyMatch(staging, target, keys)})`,
    );
    return Number(rows[0][0]);
  }
  async deleteMatchingKeys(target: string, staging: string, keys: string[]): Promise<void> {
    this.assertWritable(`delete rows from ${target}`);
    await this.begin();
    try {
      await this.exec(
        `DELETE FROM ${this.qname(target)} WHERE EXISTS (SELECT 1 FROM ${this.qname(staging)} WHERE ${this.keyMatch(staging, target, keys)})`,
      );
      await this.commit();
    } catch (e) {
      try {
        await this.rollback();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  async createTable(table: TableInfo, opts: DdlOptions = {}): Promise<void> {
    this.assertWritable(`create table ${table.name}`);
    await this.exec(this.ddlFor(table, opts));
  }

  maxInsertRows(columnCount: number): number {
    return Math.max(1, Math.floor(this.maxParams / Math.max(1, columnCount)));
  }

  async insertRows(table: TableInfo, columns: string[], rows: unknown[][]): Promise<void> {
    this.assertWritable(`insert into ${table.name}`);
    if (rows.length === 0) return;
    const infos = columns.map((n) => {
      const c = table.columns.find((x) => x.name === n);
      if (!c) throw new Error(`Column ${n} not found in ${table.name}`);
      return c;
    });
    const per = this.maxInsertRows(columns.length);
    await this.begin();
    try {
      for (let i = 0; i < rows.length; i += per) {
        const { sql, params } = this.buildInsert(table.name, infos, rows.slice(i, i + per));
        await this.exec(sql, params);
      }
      await this.commit();
    } catch (e) {
      try {
        await this.rollback();
      } catch {
        /* ignore secondary failure */
      }
      throw e;
    }
  }

  async renameTable(from: string, to: string): Promise<void> {
    this.assertWritable(`rename ${from}`);
    await this.exec(this.renameSql(from, to));
  }

  async dropTable(name: string): Promise<void> {
    this.assertWritable(`drop table ${name}`);
    await this.exec(this.dropSql(name));
  }

  async countDuplicateKeys(table: string, keys: string[]): Promise<number> {
    const k = keys.map((c) => this.quote(c)).join(", ");
    const rows = await this.query(
      `SELECT COUNT(*) FROM (SELECT 1 AS x FROM ${this.qname(table)} GROUP BY ${k} HAVING COUNT(*) > 1) d`,
    );
    return Number(rows[0][0]);
  }
}
