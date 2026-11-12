import type {
  CanonicalType,
  ColumnInfo,
  ConnectionConfig,
  DefaultValue,
  FkAction,
  ForeignKeyInfo,
  IndexInfo,
  ObjectInventory,
  TableExtras,
  TableInfo,
} from "../types.js";
import { SqlAdapter, cfgStr, parseNativeType } from "./base.js";
import { parseDefault } from "./defaults.js";

export function sqliteToCanonical(raw: string): { type: CanonicalType; length?: number; precision?: number; scale?: number } {
  const { base, args } = parseNativeType(raw || "");
  const b = base;
  if (!b) return { type: "unknown" };
  if (/^(BIGINT|INT8|UNSIGNED BIG INT|INTEGER|INT)$/.test(b)) return { type: "bigint" };
  if (/^(SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|YEAR)$/.test(b)) return { type: "integer" };
  if (/^(BOOL|BOOLEAN)$/.test(b)) return { type: "boolean" };
  if (/^(DECIMAL|NUMERIC|NUMBER)$/.test(b))
    return args.length ? { type: "decimal", precision: args[0], scale: args[1] ?? 0 } : { type: "decimal" };
  if (/^(REAL|FLOAT|DOUBLE|DOUBLE PRECISION)$/.test(b)) return { type: "float" };
  if (b === "DATE") return { type: "date" };
  if (b === "TIME") return { type: "time" };
  if (/^(DATETIME|TIMESTAMP)$/.test(b)) return { type: "timestamp" };
  if (/^(TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE)$/.test(b)) return { type: "timestamptz" };
  if (b === "JSON" || b === "JSONB") return { type: "json" };
  if (b === "BLOB" || b === "BINARY" || b === "VARBINARY") return { type: "binary" };
  if (b === "UUID") return { type: "uuid" };
  if (/^(TEXT|CLOB|LONGTEXT|MEDIUMTEXT)$/.test(b)) return { type: "text" };
  if (/^(VARCHAR|NVARCHAR|CHAR|NCHAR|CHARACTER|VARYING CHARACTER|NATIVE CHARACTER)$/.test(b))
    return args.length ? { type: "string", length: args[0] } : { type: "string" };
  if (/INT/.test(b)) return { type: "bigint" };
  if (/CHAR|CLOB|TEXT/.test(b)) return { type: "text" };
  if (/REAL|FLOA|DOUB/.test(b)) return { type: "float" };
  return { type: "unknown" };
}

export class SqliteAdapter extends SqlAdapter {
  readonly kind = "sqlite" as const;
  readonly label = "SQLite";
  protected maxParams = 30000;
  protected identifierCase = "preserve" as const;
  maxIdentifierLength = 255;
  foreignKeyMode = "inline" as const;
  private db: any;
  private inSnapshot = false;

  constructor(cfg: ConnectionConfig) {
    super(cfg);
  }

  async connect(): Promise<void> {
    const { DatabaseSync } = (await import("node:sqlite")) as any;
    const path = cfgStr(this.cfg, "path", true)!;
    this.db = new DatabaseSync(path, this.readOnly && path !== ":memory:" ? { readOnly: true } : {});
    // Foreign keys are declared inside CREATE TABLE and the tables are loaded in any order, so enforcement
    // is off for this connection only. legacy_alter_table stops RENAME from rewriting other tables' references.
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("PRAGMA legacy_alter_table = ON");
  }
  async close(): Promise<void> {
    try {
      if (this.inSnapshot) this.db?.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    this.inSnapshot = false;
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = undefined;
  }

  quote(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }
  placeholder(): string {
    return "?";
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const stmt = this.db.prepare(sql);
    stmt.setReadBigInts?.(true);
    const rows: Record<string, unknown>[] = stmt.all(...params.map((p) => this.toBindable(p)));
    if (rows.length === 0) return [];
    let names: string[] | undefined;
    if (typeof stmt.columns === "function") names = stmt.columns().map((c: any) => c.name);
    return rows.map((r) => (names ? names.map((n) => r[n]) : Object.values(r)));
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) this.db.exec(sql);
    else this.db.prepare(sql).run(...params.map((p) => this.toBindable(p)));
  }

  private toBindable(v: unknown): unknown {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === undefined) return null;
    return v;
  }
  protected bind(v: unknown): unknown {
    return this.toBindable(v);
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return rows.map((r) => String(r[0]));
  }

  async describeTable(name: string): Promise<TableInfo> {
    const rows = await this.query(`PRAGMA table_info(${this.quote(name)})`);
    if (rows.length === 0) throw new Error(`Table not found: ${name}`);
    // cid, name, type, notnull, dflt_value, pk
    const pkCols = rows
      .filter((r) => Number(r[5]) > 0)
      .sort((a, b) => Number(a[5]) - Number(b[5]))
      .map((r) => String(r[1]));
    const columns: ColumnInfo[] = rows.map((r) => {
      const native = String(r[2] ?? "");
      const t = sqliteToCanonical(native);
      return {
        name: String(r[1]),
        nativeType: native || "(none)",
        nullable: Number(r[3]) === 0 && !pkCols.includes(String(r[1])),
        ...t,
      };
    });
    return { name, columns, primaryKey: pkCols };
  }

  /**
   * Opt-in (`snapshot: true`). One read transaction for the whole run. In WAL mode writers keep going and
   * this connection keeps seeing the data as of its first read; in rollback-journal mode writers wait.
   */
  async beginSnapshot(): Promise<boolean> {
    if (this.cfg.snapshot !== true) return false;
    if (this.inSnapshot) return true;
    this.db.exec("BEGIN");
    this.inSnapshot = true;
    // A deferred transaction takes its snapshot at the first read, so take it now.
    this.db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").all();
    return true;
  }
  async endSnapshot(): Promise<void> {
    if (!this.inSnapshot) return;
    this.inSnapshot = false;
    this.db.exec("ROLLBACK");
  }

  async describeExtras(name: string): Promise<TableExtras> {
    const out: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    const info = await this.query(`PRAGMA table_info(${this.quote(name)})`);
    for (const r of info) {
      const col = String(r[1]);
      if (r[4] === null || r[4] === undefined) continue;
      const d = parseDefault(String(r[4]));
      if (d.value) out.defaults[col] = d.value as DefaultValue;
      else if (d.unsupported) out.notes.push(`Column ${col}: default ${d.unsupported} is not portable and was not migrated.`);
    }
    // A lone INTEGER PRIMARY KEY is an alias for the rowid, so SQLite assigns the next value itself when none is given
    // (AUTOINCREMENT only adds a promise never to reuse numbers). WITHOUT ROWID tables have no such alias.
    const sqlRow = await this.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
    const createSql = String(sqlRow[0]?.[0] ?? "");
    const pk = info.filter((r) => Number(r[5]) > 0);
    if (pk.length === 1 && /^INTEGER$/i.test(String(pk[0][2])) && !/WITHOUT\s+ROWID/i.test(createSql)) out.identity = String(pk[0][1]);

    const idx = await this.query(`PRAGMA index_list(${this.quote(name)})`);
    for (const r of idx) {
      // seq, name, unique, origin, partial
      const iname = String(r[1]);
      const origin = String(r[3]);
      if (origin === "pk") continue;
      if (Number(r[4]) === 1) {
        out.notes.push(`Index ${iname}: partial indexes are not migrated.`);
        continue;
      }
      const cols = await this.query(`PRAGMA index_info(${this.quote(iname)})`);
      if (cols.some((c) => c[2] === null || Number(c[1]) < 0)) {
        out.notes.push(`Index ${iname}: expression indexes are not migrated.`);
        continue;
      }
      const auto = iname.startsWith("sqlite_autoindex_");
      out.indexes.push({
        name: auto ? `uq_${name}_${cols.map((c) => String(c[2])).join("_")}` : iname,
        columns: cols.sort((a, b) => Number(a[0]) - Number(b[0])).map((c) => String(c[2])),
        unique: Number(r[2]) === 1,
      });
    }

    const fks = await this.query(`PRAGMA foreign_key_list(${this.quote(name)})`);
    const byId = new Map<number, unknown[][]>();
    for (const r of fks) byId.set(Number(r[0]), [...(byId.get(Number(r[0])) ?? []), r]);
    for (const [, parts] of byId) {
      parts.sort((a, b) => Number(a[1]) - Number(b[1]));
      const refTable = String(parts[0][2]);
      let refCols = parts.map((p) => (p[4] === null ? null : String(p[4])));
      if (refCols.some((c) => c === null)) {
        const refInfo = await this.query(`PRAGMA table_info(${this.quote(refTable)})`);
        refCols = refInfo
          .filter((r) => Number(r[5]) > 0)
          .sort((a, b) => Number(a[5]) - Number(b[5]))
          .map((r) => String(r[1]));
      }
      const cols = parts.map((p) => String(p[3]));
      out.foreignKeys.push({
        name: `fk_${name}_${cols.join("_")}`,
        columns: cols,
        refTable,
        refColumns: refCols as string[],
        onUpdate: sqliteAction(parts[0][5]),
        onDelete: sqliteAction(parts[0][6]),
      });
    }
    return out;
  }

  async listObjects(): Promise<ObjectInventory[]> {
    const rows = await this.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY type, name",
    );
    return rows.map((r) => ({
      kind: String(r[0]) as "view" | "trigger",
      name: String(r[1]),
      table: String(r[2]),
      definition: r[3] === null ? undefined : String(r[3]),
    }));
  }

  /** Foreign keys live inside CREATE TABLE here and go away with the table. */
  async addForeignKey(_table: string, _fk: ForeignKeyInfo): Promise<void> {
    throw new Error("SQLite declares foreign keys inside CREATE TABLE.");
  }
  async dropForeignKey(): Promise<void> {}

  async createIndex(table: string, index: IndexInfo): Promise<void> {
    await super.createIndex(table, index);
  }

  ddlType(c: ColumnInfo): string {
    if (c.identity) return "INTEGER"; // exactly this spelling makes the column an alias for the rowid, which auto-assigns max+1
    switch (c.type) {
      case "integer":
        return "INTEGER";
      case "bigint":
        return "BIGINT";
      case "decimal":
        return c.precision !== undefined ? `DECIMAL(${c.precision},${c.scale ?? 0})` : "NUMERIC";
      case "float":
        return "REAL";
      case "boolean":
        return "BOOLEAN";
      case "string":
        return c.length !== undefined ? `VARCHAR(${c.length})` : "TEXT";
      case "text":
      case "unknown":
        return "TEXT";
      case "date":
        return "DATE";
      case "time":
        return "TIME";
      case "timestamp":
        return "TIMESTAMP";
      case "timestamptz":
        return "TIMESTAMPTZ";
      case "json":
        return "JSON";
      case "binary":
        return "BLOB";
      case "uuid":
        return "UUID";
    }
  }
}

function sqliteAction(v: unknown): FkAction | undefined {
  const a = String(v ?? "").toUpperCase();
  return a === "CASCADE" || a === "SET NULL" || a === "RESTRICT" || a === "SET DEFAULT" ? a : undefined;
}
