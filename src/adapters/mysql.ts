import type {
  CanonicalType,
  ColumnInfo,
  ConnectionConfig,
  DefaultValue,
  FkAction,
  ForeignKeyInfo,
  ObjectInventory,
  TableExtras,
  TableInfo,
} from "../types.js";
import { SqlAdapter, cfgStr, lazyImport } from "./base.js";
import { parseDefault } from "./defaults.js";

export function mysqlToCanonical(
  dataType: string,
  columnType: string,
  len: number | null,
  prec: number | null,
  scale: number | null,
): { type: CanonicalType; length?: number; precision?: number; scale?: number } {
  const t = dataType.toLowerCase();
  const unsigned = /unsigned/i.test(columnType);
  switch (t) {
    case "tinyint":
      return /^tinyint\(1\)/i.test(columnType) ? { type: "boolean" } : { type: "integer" };
    case "smallint":
    case "mediumint":
    case "year":
      return { type: "integer" };
    case "int":
    case "integer":
      return unsigned ? { type: "bigint" } : { type: "integer" };
    case "bigint":
      return unsigned ? { type: "decimal", precision: 20, scale: 0 } : { type: "bigint" };
    case "decimal":
    case "numeric":
      return prec !== null ? { type: "decimal", precision: prec, scale: scale ?? 0 } : { type: "decimal" };
    case "float":
    case "double":
      return { type: "float" };
    case "char":
    case "varchar":
      return len !== null ? { type: "string", length: len } : { type: "string" };
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      return { type: "text" };
    case "enum":
    case "set":
      return { type: "string" };
    case "date":
      return { type: "date" };
    case "time":
      return { type: "time" };
    case "datetime":
      return { type: "timestamp" };
    case "timestamp":
      return { type: "timestamptz" };
    case "json":
      return { type: "json" };
    case "binary":
    case "varbinary":
    case "tinyblob":
    case "blob":
    case "mediumblob":
    case "longblob":
      return { type: "binary" };
    default:
      return { type: "unknown" };
  }
}

export class MysqlAdapter extends SqlAdapter {
  readonly kind = "mysql" as const;
  readonly label = "MySQL";
  maxIdentifierLength = 64;
  maxDecimalPrecision = 65;
  defaultDecimal = { precision: 65, scale: 30 };
  protected maxParams = 60000;
  private conn: any;
  private inSnapshot = false;

  constructor(cfg: ConnectionConfig) {
    super(cfg);
  }

  async connect(): Promise<void> {
    const mysql = await lazyImport<any>("mysql2/promise");
    const url = cfgStr(this.cfg, "url");
    const common = {
      rowsAsArray: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
    };
    this.conn = await mysql.createConnection(
      url
        ? { uri: url, ...common }
        : {
            host: cfgStr(this.cfg, "host", true),
            port: Number(cfgStr(this.cfg, "port") ?? 3306),
            user: cfgStr(this.cfg, "user"),
            password: cfgStr(this.cfg, "password"),
            database: cfgStr(this.cfg, "database", true),
            ...common,
            ...(this.cfg.ssl !== undefined ? { ssl: this.cfg.ssl } : {}),
          },
    );
    await this.conn.query("SET time_zone = '+00:00'");
    if (this.readOnly) await this.conn.query("SET SESSION TRANSACTION READ ONLY");
  }
  async close(): Promise<void> {
    this.inSnapshot = false;
    await this.conn?.end();
    this.conn = undefined;
  }

  quote(id: string): string {
    return "`" + id.replace(/`/g, "``") + "`";
  }
  placeholder(): string {
    return "?";
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const [rows] = await this.conn.query({ sql, values: params, rowsAsArray: true });
    return Array.isArray(rows) ? (rows as unknown[][]) : [];
  }
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.conn.query({ sql, values: params });
  }
  protected async begin(): Promise<void> {
    await this.exec("START TRANSACTION");
  }

  protected bind(v: unknown, col: ColumnInfo): unknown {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (col.type === "timestamptz" && typeof v === "string") return v.replace(/\+00:00$/, "");
    return v;
  }

  protected renameSql(from: string, to: string): string {
    return `RENAME TABLE ${this.qname(from)} TO ${this.qname(to)}`;
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    return rows.map((r) => String(r[0]));
  }

  async describeTable(name: string): Promise<TableInfo> {
    const cols = await this.query(
      `SELECT column_name, data_type, column_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?
        ORDER BY ordinal_position`,
      [name],
    );
    if (cols.length === 0) throw new Error(`Table not found: ${name}`);
    const pk = await this.query(
      `SELECT column_name FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY'
        ORDER BY ordinal_position`,
      [name],
    );
    const columns: ColumnInfo[] = cols.map((r) => ({
      name: String(r[0]),
      nativeType: String(r[2]),
      nullable: String(r[3]) === "YES",
      ...mysqlToCanonical(
        String(r[1]),
        String(r[2]),
        r[4] === null ? null : Number(r[4]),
        r[5] === null ? null : Number(r[5]),
        r[6] === null ? null : Number(r[6]),
      ),
    }));
    return { name, columns, primaryKey: pk.map((r) => String(r[0])) };
  }

  /** AUTO_INCREMENT continues from the highest loaded value, so no start value is needed. */
  protected columnTail(c: ColumnInfo): string {
    return c.identity ? " AUTO_INCREMENT" : "";
  }

  async dropForeignKey(table: string, name: string): Promise<void> {
    this.assertWritable(`drop foreign key ${name}`);
    await this.exec(`ALTER TABLE ${this.qname(table)} DROP FOREIGN KEY ${this.quote(name)}`);
  }

  protected boolLiteral(b: boolean): string {
    return b ? "1" : "0";
  }

  /** Consistent read view for the whole run (InnoDB, REPEATABLE READ). */
  async beginSnapshot(): Promise<boolean> {
    if (this.inSnapshot) return true;
    await this.conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await this.conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    this.inSnapshot = true;
    return true;
  }
  /** DATETIME(6) columns need CURRENT_TIMESTAMP(6), and DATE defaults must be written as expressions. */
  protected nowSql(): string {
    return "CURRENT_TIMESTAMP(6)";
  }
  protected todaySql(): string {
    return "(CURRENT_DATE)";
  }
  async endSnapshot(): Promise<void> {
    if (!this.inSnapshot) return;
    this.inSnapshot = false;
    await this.conn.query("COMMIT");
  }

  async describeExtras(name: string): Promise<TableExtras> {
    const out: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    const cols = await this.query(
      `SELECT column_name, column_default, extra, generation_expression
         FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
      [name],
    );
    const identities: string[] = [];
    for (const r of cols) {
      const col = String(r[0]);
      const extra = String(r[2] ?? "").toLowerCase();
      if (extra.includes("auto_increment")) {
        identities.push(col);
        continue;
      }
      if (extra.includes("generated") && !extra.includes("default_generated")) {
        out.notes.push(`Column ${col}: generated column; its values are copied but the expression is not.`);
        continue;
      }
      if (r[1] === null || r[1] === undefined) continue;
      const raw = String(r[1]);
      if (raw === "NULL") continue;
      let d: DefaultValue | undefined;
      if (extra.includes("default_generated") || /^'.*'$/s.test(raw)) {
        const p = parseDefault(raw);
        if (p.value) d = p.value as DefaultValue;
        else {
          out.notes.push(`Column ${col}: default ${raw} is not portable and was not migrated.`);
          continue;
        }
      } else d = { kind: "literal", value: raw }; // MySQL hands back the bare literal; the planner fits it to the column type
      out.defaults[col] = d;
    }
    if (identities.length === 1) out.identity = identities[0];
    else if (identities.length > 1) out.notes.push(`Several AUTO_INCREMENT columns: ${identities.join(", ")}`);

    const stats = await this.query(
      `SELECT index_name, non_unique, column_name, sub_part, index_type
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name <> 'PRIMARY'
        ORDER BY index_name, seq_in_index`,
      [name],
    );
    const byIndex = new Map<string, unknown[][]>();
    for (const r of stats) byIndex.set(String(r[0]), [...(byIndex.get(String(r[0])) ?? []), r]);
    for (const [iname, parts] of byIndex) {
      const type = String(parts[0][4]).toUpperCase();
      if (type === "FULLTEXT" || type === "SPATIAL") out.notes.push(`Index ${iname}: ${type} indexes are not migrated.`);
      else if (parts.some((p) => p[2] === null)) out.notes.push(`Index ${iname}: functional indexes are not migrated.`);
      else if (parts.some((p) => p[3] !== null)) out.notes.push(`Index ${iname}: prefix indexes are not migrated.`);
      else
        out.indexes.push({
          name: iname,
          columns: parts.map((p) => String(p[2])),
          unique: Number(parts[0][1]) === 0,
        });
    }

    const fkRows = await this.query(
      `SELECT k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule, k.referenced_table_schema
         FROM information_schema.key_column_usage k
         JOIN information_schema.referential_constraints r
           ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
        WHERE k.table_schema = DATABASE() AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
        ORDER BY k.constraint_name, k.ordinal_position`,
      [name],
    );
    const byFk = new Map<string, unknown[][]>();
    for (const r of fkRows) byFk.set(String(r[0]), [...(byFk.get(String(r[0])) ?? []), r]);
    const act = (v: unknown): FkAction | undefined => {
      const a = String(v ?? "").toUpperCase();
      return a === "CASCADE" || a === "SET NULL" || a === "RESTRICT" || a === "NO ACTION" || a === "SET DEFAULT" ? a : undefined;
    };
    for (const [fname, parts] of byFk) {
      out.foreignKeys.push({
        name: fname,
        columns: parts.map((p) => String(p[1])),
        refTable: String(parts[0][2]),
        refColumns: parts.map((p) => String(p[3])),
        onUpdate: act(parts[0][4]),
        onDelete: act(parts[0][5]),
      } satisfies ForeignKeyInfo);
    }
    return out;
  }

  async listObjects(): Promise<ObjectInventory[]> {
    const out: ObjectInventory[] = [];
    const views = await this.query(
      "SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = DATABASE() ORDER BY table_name",
    );
    for (const r of views) out.push({ kind: "view", name: String(r[0]), definition: String(r[1]) });
    const trig = await this.query(
      "SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema = DATABASE() ORDER BY trigger_name",
    );
    for (const r of trig) out.push({ kind: "trigger", name: String(r[0]), table: String(r[1]) });
    const routines = await this.query(
      "SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = DATABASE() ORDER BY routine_name",
    );
    for (const r of routines) out.push({ kind: "routine", name: String(r[0]), definition: String(r[1]).toLowerCase() });
    return out;
  }

  ddlType(c: ColumnInfo, isPk: boolean): string {
    switch (c.type) {
      case "integer":
        return "INT";
      case "bigint":
        return "BIGINT";
      case "decimal":
        return `DECIMAL(${c.precision ?? this.defaultDecimal.precision},${c.precision !== undefined ? (c.scale ?? 0) : this.defaultDecimal.scale})`;
      case "float":
        return "DOUBLE";
      case "boolean":
        return "TINYINT(1)";
      case "string":
        if (c.length !== undefined && c.length <= 16000) return `VARCHAR(${c.length})`;
        return isPk ? "VARCHAR(255)" : "LONGTEXT";
      case "text":
      case "unknown":
        return isPk ? "VARCHAR(255)" : "LONGTEXT";
      case "date":
        return "DATE";
      case "time":
        return "TIME(6)";
      case "timestamp":
      case "timestamptz":
        return "DATETIME(6)";
      case "json":
        return "JSON";
      case "binary":
        return isPk ? "VARBINARY(255)" : "LONGBLOB";
      case "uuid":
        return "CHAR(36)";
    }
  }
  protected ddlSuffix(): string {
    return " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
  }
}
