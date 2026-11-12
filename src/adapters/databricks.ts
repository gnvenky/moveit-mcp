import type {
  CanonicalType,
  ColumnInfo,
  ConnectionConfig,
  DefaultValue,
  ObjectInventory,
  TableExtras,
  TableInfo,
} from "../types.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { SqlAdapter, cfgStr, lazyImport, parseNativeType } from "./base.js";
import { ndjson, sqlQuoted, withTempFile } from "./bulk.js";
import { parseDefault } from "./defaults.js";

type Mapped = { type: CanonicalType; length?: number; precision?: number; scale?: number };

/** Map a Databricks / Spark SQL data type string (e.g. "decimal(10,2)", "TIMESTAMP_NTZ") to canonical. */
export function databricksToCanonical(raw: string, precision?: number | null, scale?: number | null): Mapped {
  // complex types come back parameterised ("array<string>", "map<string,int>", "struct<a:int>"); the family is what matters
  const family = raw.split("<")[0];
  const { base, args } = parseNativeType(family);
  switch (base) {
    case "TINYINT":
    case "SMALLINT":
    case "INT":
    case "INTEGER":
      return { type: "integer" };
    case "BIGINT":
    case "LONG":
      return { type: "bigint" };
    case "DECIMAL":
    case "DEC":
    case "NUMERIC": {
      const p = precision ?? args[0];
      const s = scale ?? args[1] ?? 0;
      return p !== undefined && p !== null ? { type: "decimal", precision: p, scale: s } : { type: "decimal" };
    }
    case "FLOAT":
    case "DOUBLE":
    case "REAL":
      return { type: "float" };
    case "BOOLEAN":
      return { type: "boolean" };
    case "STRING":
      return { type: "string" };
    case "VARCHAR":
    case "CHAR":
      return args.length ? { type: "string", length: args[0] } : { type: "string" };
    case "DATE":
      return { type: "date" };
    case "TIMESTAMP_NTZ":
      return { type: "timestamp" };
    case "TIMESTAMP":
    case "TIMESTAMP_LTZ":
      return { type: "timestamptz" };
    case "BINARY":
      return { type: "binary" };
    case "VARIANT":
    case "ARRAY":
    case "MAP":
    case "STRUCT":
    case "OBJECT":
      return { type: "json" };
    default:
      return { type: "unknown" };
  }
}

const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const INT_RE = /^-?\d+$/;
const TS_JSON = "yyyy-MM-dd'T'HH:mm:ss.SSSSSS";

/** Inject-proof string literal: plain ASCII is quoted, anything else is sent as hex and decoded. */
export function sparkString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s) && !/['\\]/.test(s)) return `'${s}'`;
  return `decode(unhex('${Buffer.from(s, "utf8").toString("hex")}'), 'UTF-8')`;
}

export class DatabricksAdapter extends SqlAdapter {
  readonly kind = "databricks" as const;
  readonly label = "Databricks";
  maxIdentifierLength = 255;
  maxDecimalPrecision = 38;
  defaultDecimal = { precision: 38, scale: 18 };
  enforcesPrimaryKey = false;
  protected identifierCase = "lower" as const;
  protected transactional = false; // each statement is atomic; the staged-table design supplies atomicity
  private client: any;
  private session: any;
  private catalog = "";
  private schema = "";
  private snapshotTs?: string;
  supportsIndexes = false;
  foreignKeyMode = "none" as const;

  private readonly volume?: string;

  constructor(cfg: ConnectionConfig) {
    super(cfg);
    const bl = cfg.bulkLoad as { volume?: string } | undefined;
    if (bl && typeof bl === "object" && typeof bl.volume === "string") {
      const v = bl.volume.replace(/\/+$/, "");
      if (!/^\/Volumes\/[\w.-]+\/[\w.-]+\/[\w.-]+(\/[\w./-]+)?$/.test(v))
        throw new Error('bulkLoad.volume must look like "/Volumes/<catalog>/<schema>/<volume>"');
      this.volume = v;
      this.preferredBatchSize = 50000;
    }
    this.supportsPrimaryKey = cfg.primaryKeys !== false; // set primaryKeys:false for hive_metastore
    // Column DEFAULTs need a Delta table feature to be switched on, and identity columns need a recent runtime,
    // so defaults are opt-in and identity is opt-out. Neither has been run against a live workspace.
    this.supportsDefaults = cfg.defaults === true;
    this.supportsIdentity = cfg.identity !== false;
  }

  async connect(): Promise<void> {
    const mod = await lazyImport<any>("@databricks/sql");
    const DBSQLClient = mod.DBSQLClient ?? mod.default?.DBSQLClient;
    this.client = new DBSQLClient();
    await this.client.connect({
      host: cfgStr(this.cfg, "host", true),
      path: cfgStr(this.cfg, "httpPath", true),
      token: cfgStr(this.cfg, "token", true),
    });
    this.catalog = cfgStr(this.cfg, "catalog") ?? "main";
    this.schema = cfgStr(this.cfg, "schema") ?? "default";
    this.session = await this.client.openSession({ initialCatalog: this.catalog, initialSchema: this.schema });
    await this.exec("SET TIME ZONE 'UTC'");
  }
  async close(): Promise<void> {
    try {
      await this.session?.close();
    } finally {
      await this.client?.close();
      this.session = undefined;
      this.client = undefined;
    }
  }

  protected schemaParts(): string[] {
    return [this.catalog, this.schema];
  }
  quote(id: string): string {
    return "`" + id.replace(/`/g, "``") + "`";
  }
  placeholder(): string {
    return "?";
  }

  private async run(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const op = await this.session.executeStatement(sql, {
      runAsync: true,
      maxRows: 10000,
      ...(params.length ? { ordinalParameters: params } : {}),
    });
    try {
      const rows: Record<string, unknown>[] = await op.fetchAll({ maxRows: 10000 });
      return rows.map((r) => Object.values(r));
    } finally {
      await op.close();
    }
  }
  async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return this.run(sql, params);
  }
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.run(sql, params);
  }

  /** Alias every column as c{i} so object-shaped results keep their order, and cast lossy types to text. */
  protected selectExpr(col: ColumnInfo, i: number): string {
    const q = this.quote(col.name);
    let e: string;
    switch (col.type) {
      case "bigint":
      case "decimal":
        e = `CAST(${q} AS STRING)`;
        break;
      case "date":
        e = `CAST(${q} AS STRING)`;
        break;
      case "timestamp":
      case "timestamptz":
        e = `date_format(${q}, "${TS_JSON}")`;
        break;
      case "binary":
        e = `concat('0x', hex(${q}))`;
        break;
      case "json":
        e = /^(VARIANT|ARRAY|MAP|STRUCT)/i.test(col.nativeType) ? `to_json(${q})` : q;
        break;
      default:
        e = q;
    }
    return `${e} AS ${this.quote("c" + i)}`;
  }

  placeholderFor(col: ColumnInfo, _i: number): string {
    switch (col.type) {
      case "bigint":
        return "CAST(? AS BIGINT)";
      case "decimal":
        return `CAST(? AS DECIMAL(${Math.min(col.precision ?? 38, 38)},${col.precision !== undefined ? (col.scale ?? 0) : 18}))`;
      case "date":
        return "CAST(? AS DATE)";
      case "timestamp":
        return "CAST(? AS TIMESTAMP_NTZ)";
      case "timestamptz":
        return "CAST(? AS TIMESTAMP)";
      default:
        return "?";
    }
  }

  protected bind(v: unknown, col: ColumnInfo): unknown {
    if (v === null || v === undefined) return null;
    if (col.type === "bigint" || col.type === "decimal") return String(v);
    return v;
  }

  /** Inline literals sidestep Databricks' limit on parameter markers; every literal is validated or hex-encoded. */
  private literal(v: unknown, c: ColumnInfo): string {
    if (v === null || v === undefined) return "NULL";
    const s = String(v);
    switch (c.type) {
      case "integer":
      case "bigint":
        if (!INT_RE.test(s)) throw new Error(`Refusing non-integer literal for ${c.name}`);
        return s;
      case "decimal":
        if (!NUM_RE.test(s)) throw new Error(`Refusing non-numeric literal for ${c.name}`);
        return s;
      case "float":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Refusing non-finite float for ${c.name}`);
        return String(v);
      case "boolean":
        return v ? "TRUE" : "FALSE";
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Bad date literal for ${c.name}`);
        return `DATE'${s}'`;
      case "timestamp":
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) throw new Error(`Bad timestamp literal for ${c.name}`);
        return `TIMESTAMP_NTZ'${s}'`;
      case "timestamptz":
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/.test(s)) throw new Error(`Bad timestamptz literal for ${c.name}`);
        return `TIMESTAMP'${s}'`;
      case "binary":
        return `X'${(Buffer.isBuffer(v) ? v : Buffer.from(s)).toString("hex")}'`;
      default:
        return sparkString(s);
    }
  }

  buildInsert(table: string, cols: ColumnInfo[], rows: unknown[][]): { sql: string; params: unknown[] } {
    const tuples = rows.map((r) => `(${cols.map((c, j) => this.literal(r[j], c)).join(", ")})`);
    return {
      sql: `INSERT INTO ${this.qname(table)} (${cols.map((c) => this.quote(c.name)).join(", ")}) VALUES ${tuples.join(", ")}`,
      params: [],
    };
  }

  maxInsertRows(): number {
    return 500;
  }

  /** What each column looks like when read back from a JSON file whose fields are all strings. */
  private bulkExpr(c: ColumnInfo): string {
    const q = this.quote(c.name);
    switch (c.type) {
      case "integer":
        return `CAST(${q} AS INT)`;
      case "float":
        return `CAST(${q} AS DOUBLE)`;
      case "boolean":
        return `CAST(${q} AS BOOLEAN)`;
      case "binary":
        return `unhex(${q})`;
      case "bigint":
      case "decimal":
      case "date":
      case "timestamp":
      case "timestamptz":
        return this.placeholderFor(c, 1).replace("?", q);
      default:
        return q;
    }
  }

  /**
   * Opt-in (`bulkLoad: { "volume": "/Volumes/cat/schema/vol" }`): each batch is uploaded to a Unity Catalog volume as
   * newline-delimited JSON and loaded with INSERT ... SELECT FROM read_files(...), instead of inline VALUES.
   * Not verified against a live workspace.
   */
  private async bulkInsert(table: TableInfo, infos: ColumnInfo[], rows: unknown[][]): Promise<void> {
    const remote = `${this.volume}/.moveit/${randomUUID()}.json`;
    const text = ndjson(infos, rows, (v, c) => {
      if (Buffer.isBuffer(v)) return v.toString("hex");
      if (c.type === "boolean") return v ? "true" : "false";
      return typeof v === "number" || typeof v === "bigint" ? String(v) : v;
    });
    await withTempFile(text, async (file) => {
      const op = await this.session.executeStatement(`PUT ${sqlQuoted(file)} INTO ${sqlQuoted(remote)} OVERWRITE`, {
        stagingAllowedLocalPath: [tmpdir()],
      });
      await op.close();
      try {
        const schema = infos.map((c) => `${this.quote(c.name)} STRING`).join(", ");
        const cols = infos.map((c) => this.quote(c.name)).join(", ");
        await this.exec(
          `INSERT INTO ${this.qname(table.name)} (${cols}) SELECT ${infos.map((c) => this.bulkExpr(c)).join(", ")} FROM read_files(${sqlQuoted(remote)}, format => 'json', schema => ${sqlQuoted(schema)})`,
        );
      } finally {
        try {
          await this.exec(`REMOVE ${sqlQuoted(remote)}`);
        } catch {
          /* a leftover file in a hidden folder of the volume is harmless */
        }
      }
    });
  }

  async insertRows(table: TableInfo, columns: string[], rows: unknown[][]): Promise<void> {
    this.assertWritable(`insert into ${table.name}`);
    const infos = columns.map((n) => {
      const c = table.columns.find((x) => x.name === n);
      if (!c) throw new Error(`Column ${n} not found in ${table.name}`);
      return c;
    });
    if (this.volume) {
      if (rows.length) await this.bulkInsert(table, infos, rows);
      return;
    }
    // chunk by row count and by statement size (~4 MB) to stay under warehouse limits
    let start = 0;
    while (start < rows.length) {
      let end = start;
      let bytes = 0;
      while (end < rows.length && end - start < this.maxInsertRows() && bytes < 4_000_000) {
        bytes += rows[end].reduce<number>((n, v) => n + (typeof v === "string" ? v.length * 2 : 24), 0);
        end++;
      }
      const { sql } = this.buildInsert(table.name, infos, rows.slice(start, end));
      await this.exec(sql);
      start = end;
    }
  }

  protected ddlSuffix(): string {
    return this.supportsDefaults ? " USING DELTA TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported')" : " USING DELTA";
  }

  protected identityClause(c: ColumnInfo): string {
    const start = c.identity?.start ?? "1";
    if (!/^\d+$/.test(start)) throw new Error(`Invalid identity start value: ${start}`);
    return ` GENERATED BY DEFAULT AS IDENTITY (START WITH ${start} INCREMENT BY 1)`;
  }
  protected stringLiteral(s: string): string {
    return sparkString(s);
  }
  protected nowSql(): string {
    return "current_timestamp()";
  }
  protected todaySql(): string {
    return "current_date()";
  }
  async maxValue(table: string, column: string): Promise<string | null> {
    const rows = await this.query(`SELECT CAST(MAX(${this.quote(column)}) AS STRING) FROM ${this.qname(table)}`);
    const v = rows[0]?.[0];
    return v === null || v === undefined ? null : String(v);
  }

  /** Opt-in (`snapshot: true`): Delta time travel, every table read AS OF one instant. Not verified against a live workspace. */
  async beginSnapshot(): Promise<boolean> {
    if (this.cfg.snapshot !== true) return false;
    if (this.snapshotTs) return true;
    const r = await this.query("SELECT date_format(current_timestamp(), 'yyyy-MM-dd HH:mm:ss.SSS')");
    this.snapshotTs = String(r[0][0]);
    return true;
  }
  async endSnapshot(): Promise<void> {
    this.snapshotTs = undefined;
  }
  protected readFrom(table: string): string {
    return this.snapshotTs ? `${this.qname(table)} TIMESTAMP AS OF '${this.snapshotTs}'` : this.qname(table);
  }

  async describeExtras(name: string): Promise<TableExtras> {
    const out: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    const cat = this.quote(this.catalog);
    let rows: unknown[][] = [];
    try {
      rows = await this.query(
        `SELECT column_name, column_default, is_identity FROM ${cat}.information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [this.schema, name],
      );
    } catch {
      out.notes.push("This catalog has no information_schema; defaults and identity columns were not read.");
      return out;
    }
    const identities: string[] = [];
    for (const r of rows) {
      const col = String(r[0]);
      if (String(r[2]) === "YES") {
        identities.push(col);
        continue;
      }
      if (r[1] === null || r[1] === undefined) continue;
      const d = parseDefault(String(r[1]));
      if (d.value) out.defaults[col] = d.value as DefaultValue;
      else if (d.unsupported) out.notes.push(`Column ${col}: default ${d.unsupported} is not portable and was not migrated.`);
    }
    if (identities.length === 1) out.identity = identities[0];
    else if (identities.length > 1) out.notes.push(`Several identity columns: ${identities.join(", ")}`);
    return out;
  }

  async listObjects(): Promise<ObjectInventory[]> {
    const out: ObjectInventory[] = [];
    const cat = this.quote(this.catalog);
    try {
      for (const r of await this.query(`SELECT table_name, view_definition FROM ${cat}.information_schema.views WHERE table_schema = ? ORDER BY table_name`, [this.schema]))
        out.push({ kind: "view", name: String(r[0]), definition: r[1] === null ? undefined : String(r[1]) });
      for (const r of await this.query(`SELECT routine_name, routine_type FROM ${cat}.information_schema.routines WHERE routine_schema = ? ORDER BY routine_name`, [this.schema]))
        out.push({ kind: "routine", name: String(r[0]), definition: String(r[1]).toLowerCase() });
    } catch {
      /* no information_schema on this catalog */
    }
    return out;
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query(`SHOW TABLES IN ${this.quote(this.catalog)}.${this.quote(this.schema)}`);
    // columns: database, tableName, isTemporary
    return rows.filter((r) => String(r[2]) !== "true").map((r) => String(r[1]));
  }

  async describeTable(name: string): Promise<TableInfo> {
    const cat = this.quote(this.catalog);
    let columns: ColumnInfo[] = [];
    let primaryKey: string[] = [];
    try {
      const cols = await this.query(
        `SELECT column_name, full_data_type, numeric_precision, numeric_scale, is_nullable
           FROM ${cat}.information_schema.columns
          WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
        [this.schema, name],
      );
      columns = cols.map((r) => {
        const full = String(r[1]);
        const prec = r[2] === null || r[2] === undefined ? null : Number(r[2]);
        const scale = r[3] === null || r[3] === undefined ? null : Number(r[3]);
        return {
          name: String(r[0]),
          nativeType: full,
          nullable: String(r[4]) === "YES",
          ...databricksToCanonical(full, /^decimal/i.test(full) ? prec : null, /^decimal/i.test(full) ? scale : null),
        };
      });
      const pk = await this.query(
        `SELECT kcu.column_name
           FROM ${cat}.information_schema.table_constraints tc
           JOIN ${cat}.information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ? AND tc.table_name = ?
          ORDER BY kcu.ordinal_position`,
        [this.schema, name],
      );
      primaryKey = pk.map((r) => String(r[0]));
    } catch {
      columns = [];
    }
    if (columns.length === 0) {
      // hive_metastore / no information_schema: fall back to DESCRIBE TABLE (no nullability, no PK info)
      const rows = await this.query(`DESCRIBE TABLE ${this.qname(name)}`);
      for (const r of rows) {
        const col = String(r[0] ?? "");
        if (!col || col.startsWith("#")) break;
        const dt = String(r[1]);
        columns.push({ name: col, nativeType: dt, nullable: true, ...databricksToCanonical(dt) });
      }
    }
    if (columns.length === 0) throw new Error(`Table not found: ${this.catalog}.${this.schema}.${name}`);
    return { name, columns, primaryKey };
  }

  ddlType(c: ColumnInfo): string {
    if (c.identity) return "BIGINT"; // Delta identity columns only support BIGINT
    switch (c.type) {
      case "integer":
        return "INT";
      case "bigint":
        return "BIGINT";
      case "decimal":
        return c.precision !== undefined
          ? `DECIMAL(${Math.min(c.precision, 38)},${c.scale ?? 0})`
          : `DECIMAL(${this.defaultDecimal.precision},${this.defaultDecimal.scale})`;
      case "float":
        return "DOUBLE";
      case "boolean":
        return "BOOLEAN";
      case "string":
      case "text":
      case "unknown":
      case "json": // STRING for portability; switch to VARIANT on DBR 15.3+ if you prefer
      case "time": // no TIME type
      case "uuid":
        return "STRING";
      case "date":
        return "DATE";
      case "timestamp":
        return "TIMESTAMP_NTZ";
      case "timestamptz":
        return "TIMESTAMP";
      case "binary":
        return "BINARY";
    }
  }
}
