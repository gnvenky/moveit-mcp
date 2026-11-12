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
import { SqlAdapter, cfgStr, lazyImport } from "./base.js";
import { ndjson, sqlQuoted, withTempFile } from "./bulk.js";
import { parseDefault } from "./defaults.js";

type Mapped = { type: CanonicalType; length?: number; precision?: number; scale?: number };

/** Map an INFORMATION_SCHEMA.COLUMNS row to a canonical type. */
export function snowflakeToCanonical(
  dataType: string,
  charLength: number | null,
  precision: number | null,
  scale: number | null,
): Mapped {
  const t = dataType.toUpperCase();
  switch (t) {
    case "NUMBER":
    case "DECIMAL":
    case "NUMERIC": {
      const p = precision ?? 38;
      const s = scale ?? 0;
      if (s === 0) {
        if (p <= 9) return { type: "integer" };
        if (p <= 18 || p === 38) return { type: "bigint" }; // NUMBER(38,0) is Snowflake's INTEGER; the dry run checks real values
        return { type: "decimal", precision: p, scale: 0 };
      }
      return { type: "decimal", precision: p, scale: s };
    }
    case "FLOAT":
    case "REAL":
    case "DOUBLE":
      return { type: "float" };
    case "TEXT":
    case "VARCHAR":
    case "CHAR":
    case "STRING":
      return charLength !== null && charLength < 16777216 ? { type: "string", length: charLength } : { type: "string" };
    case "BINARY":
      return { type: "binary" };
    case "BOOLEAN":
      return { type: "boolean" };
    case "DATE":
      return { type: "date" };
    case "TIME":
      return { type: "time" };
    case "TIMESTAMP_NTZ":
      return { type: "timestamp" };
    case "TIMESTAMP_LTZ":
    case "TIMESTAMP_TZ":
      return { type: "timestamptz" };
    case "VARIANT":
    case "OBJECT":
    case "ARRAY":
      return { type: "json" };
    default:
      return { type: "unknown" };
  }
}

const TS_OUT = "YYYY-MM-DD\"T\"HH24:MI:SS.FF6";

export class SnowflakeAdapter extends SqlAdapter {
  readonly kind = "snowflake" as const;
  readonly label = "Snowflake";
  maxIdentifierLength = 255;
  maxDecimalPrecision = 38;
  defaultDecimal = { precision: 38, scale: 18 };
  enforcesPrimaryKey = false;
  protected identifierCase = "upper" as const;
  protected maxParams = 15000; // Snowflake allows 16,384 bind variables per statement
  private conn: any;
  private database = "";
  private schema = "";
  private snapshotTs?: string;
  // Constraints are informational here and there are no indexes: nothing to migrate.
  supportsIndexes = false;
  foreignKeyMode = "none" as const;

  private readonly bulk: boolean;

  constructor(cfg: ConnectionConfig) {
    super(cfg);
    this.supportsIdentity = cfg.identity !== false;
    this.bulk = cfg.bulkLoad === true;
    if (this.bulk) this.preferredBatchSize = 50000;
  }

  /**
   * Opt-in (`bulkLoad: true`): each batch is written as newline-delimited JSON, PUT to the user stage and loaded
   * with one COPY INTO, instead of a multi-row INSERT. Values are cast with the same expressions the INSERT path
   * uses. Not verified against a live Snowflake account.
   */
  async insertRows(table: TableInfo, columns: string[], rows: unknown[][]): Promise<void> {
    if (!this.bulk) return super.insertRows(table, columns, rows);
    this.assertWritable(`insert into ${table.name}`);
    if (rows.length === 0) return;
    const infos = columns.map((n) => {
      const c = table.columns.find((x) => x.name === n);
      if (!c) throw new Error(`Column ${n} not found in ${table.name}`);
      return c;
    });
    const stage = `@~/moveit/${randomUUID()}/`;
    const text = ndjson(infos, rows, (v, c) => this.bind(v, c));
    await withTempFile(text, async (file) => {
      await this.exec(`PUT ${sqlQuoted("file://" + file)} ${stage} AUTO_COMPRESS = TRUE OVERWRITE = TRUE`);
      try {
        const exprs = infos.map((c) => this.placeholderFor(c, 1).replace("?", `($1:${this.quote(c.name)}::STRING)`));
        const res = await this.query(
          `COPY INTO ${this.qname(table.name)} (${infos.map((c) => this.quote(c.name)).join(", ")}) FROM (SELECT ${exprs.join(", ")} FROM ${stage}) FILE_FORMAT = (TYPE = JSON) ON_ERROR = ABORT_STATEMENT PURGE = TRUE`,
        );
        const loaded = res.reduce((n, r) => n + Number(r[3] ?? 0), 0); // columns: file, status, rows_parsed, rows_loaded, ...
        if (loaded !== rows.length) throw new Error(`COPY INTO loaded ${loaded} of ${rows.length} rows`);
      } finally {
        try {
          await this.exec(`REMOVE ${stage}`);
        } catch {
          /* the stage is private to this user; a leftover file is harmless */
        }
      }
    });
  }

  async connect(): Promise<void> {
    const sf = await lazyImport<any>("snowflake-sdk");
    sf.configure?.({ logLevel: "ERROR" });
    const opts: Record<string, unknown> = {
      account: cfgStr(this.cfg, "account", true),
      username: cfgStr(this.cfg, "username", true),
      warehouse: cfgStr(this.cfg, "warehouse"),
      database: cfgStr(this.cfg, "database"),
      schema: cfgStr(this.cfg, "schema"),
      role: cfgStr(this.cfg, "role"),
    };
    if (this.cfg.password) opts.password = cfgStr(this.cfg, "password");
    if (this.cfg.privateKey) {
      opts.authenticator = "SNOWFLAKE_JWT";
      opts.privateKey = cfgStr(this.cfg, "privateKey");
      if (this.cfg.privateKeyPass) opts.privateKeyPass = cfgStr(this.cfg, "privateKeyPass");
    }
    if (this.cfg.token) {
      opts.authenticator = "OAUTH";
      opts.token = cfgStr(this.cfg, "token");
    }
    if (this.cfg.authenticator) opts.authenticator = cfgStr(this.cfg, "authenticator");
    this.conn = sf.createConnection(opts);
    await new Promise<void>((resolve, reject) =>
      this.conn.connect((err: Error | undefined) => (err ? reject(err) : resolve())),
    );
    await this.exec("ALTER SESSION SET TIMEZONE = 'UTC'");
    await this.exec("ALTER SESSION SET BINARY_OUTPUT_FORMAT = 'HEX'");
    await this.exec("ALTER SESSION SET QUOTED_IDENTIFIERS_IGNORE_CASE = FALSE");
    const r = await this.query("SELECT CURRENT_DATABASE(), CURRENT_SCHEMA()");
    this.database = String(r[0][0] ?? "");
    this.schema = String(r[0][1] ?? "");
    if (!this.database || !this.schema)
      throw new Error('Snowflake connection needs "database" and "schema" (or a default for the user).');
  }
  async close(): Promise<void> {
    if (!this.conn) return;
    await new Promise<void>((resolve) => this.conn.destroy(() => resolve()));
    this.conn = undefined;
  }

  protected schemaParts(): string[] {
    return [this.database, this.schema];
  }
  quote(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }
  placeholder(): string {
    return "?";
  }

  private run(sql: string, binds: unknown[] = []): Promise<unknown[][]> {
    return new Promise((resolve, reject) =>
      this.conn.execute({
        sqlText: sql,
        binds: binds.length ? binds : undefined,
        rowMode: "array",
        complete: (err: Error | undefined, _stmt: unknown, rows: unknown[][] | undefined) =>
          err ? reject(err) : resolve(rows ?? []),
      }),
    );
  }
  async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return this.run(sql, params);
  }
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.run(sql, params);
  }

  protected selectExpr(col: ColumnInfo): string {
    const q = this.quote(col.name);
    switch (col.type) {
      case "integer":
      case "bigint":
      case "decimal":
        return `TO_VARCHAR(${q})`;
      case "date":
        return `TO_VARCHAR(${q}, 'YYYY-MM-DD')`;
      case "time":
        return `TO_VARCHAR(${q}, 'HH24:MI:SS.FF6')`;
      case "timestamp":
        return `TO_VARCHAR(${q}, '${TS_OUT}')`;
      case "timestamptz":
        return `TO_VARCHAR(CONVERT_TIMEZONE('UTC', ${q}), '${TS_OUT}')`;
      case "json":
        return `TO_VARCHAR(${q})`;
      case "binary":
        return `'0x' || HEX_ENCODE(${q})`;
      default:
        return q;
    }
  }

  /** Typed placeholder so values bound as text land in the right column type. */
  placeholderFor(col: ColumnInfo, i: number): string {
    switch (col.type) {
      case "integer":
      case "bigint":
        return "CAST(? AS NUMBER(38,0))";
      case "decimal":
        return `CAST(? AS NUMBER(${Math.min(col.precision ?? 38, 38)},${col.precision !== undefined ? (col.scale ?? 0) : 18}))`;
      case "float":
        return "CAST(? AS FLOAT)";
      case "boolean":
        return "CAST(? AS BOOLEAN)";
      case "date":
        return "TO_DATE(?, 'YYYY-MM-DD')";
      case "time":
        return "TO_TIME(?, 'HH24:MI:SS.FF6')";
      case "timestamp":
        return "TO_TIMESTAMP_NTZ(?, 'YYYY-MM-DD HH24:MI:SS.FF6')";
      case "timestamptz":
        return "TO_TIMESTAMP_TZ(?, 'YYYY-MM-DD HH24:MI:SS.FF6TZH:TZM')";
      case "json":
        return "PARSE_JSON(?)";
      case "binary":
        return "TO_BINARY(?, 'HEX')";
      default:
        return this.placeholder();
    }
  }

  protected bind(v: unknown, col: ColumnInfo): unknown {
    if (v === null || v === undefined) return null;
    if (col.type === "binary" && Buffer.isBuffer(v)) return v.toString("hex");
    if (col.type === "integer" || col.type === "bigint" || col.type === "decimal") return String(v);
    if (col.type === "boolean") return v ? "true" : "false";
    return v;
  }

  /** VALUES cannot contain PARSE_JSON(?) / TO_BINARY(?), so use SELECT ... UNION ALL SELECT ... */
  buildInsert(table: string, cols: ColumnInfo[], rows: unknown[][]): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const selects = rows.map((r) => {
      const exprs = cols.map((c, j) => {
        params.push(this.bind(r[j], c));
        return this.placeholderFor(c, params.length);
      });
      return `SELECT ${exprs.join(", ")}`;
    });
    return {
      sql: `INSERT INTO ${this.qname(table)} (${cols.map((c) => this.quote(c.name)).join(", ")}) ${selects.join(" UNION ALL ")}`,
      params,
    };
  }

  protected renameSql(from: string, to: string): string {
    return `ALTER TABLE ${this.qname(from)} RENAME TO ${this.qname(to)}`;
  }

  protected identityClause(c: ColumnInfo): string {
    const start = c.identity?.start ?? "1";
    if (!/^\d+$/.test(start)) throw new Error(`Invalid identity start value: ${start}`);
    return ` AUTOINCREMENT START ${start} INCREMENT 1`;
  }
  protected nowSql(): string {
    return "CURRENT_TIMESTAMP()";
  }
  protected todaySql(): string {
    return "CURRENT_DATE()";
  }
  async maxValue(table: string, column: string): Promise<string | null> {
    const rows = await this.query(`SELECT TO_VARCHAR(MAX(${this.quote(column)})) FROM ${this.qname(table)}`);
    const v = rows[0]?.[0];
    return v === null || v === undefined ? null : String(v);
  }

  /**
   * Opt-in (`snapshot: true`). Reads every table AS OF one instant using Time Travel, so the table's
   * retention period must cover the run. Not verified against a live account.
   */
  async beginSnapshot(): Promise<boolean> {
    if (this.cfg.snapshot !== true) return false;
    if (this.snapshotTs) return true;
    const r = await this.query("SELECT TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM')");
    this.snapshotTs = String(r[0][0]);
    return true;
  }
  async endSnapshot(): Promise<void> {
    this.snapshotTs = undefined;
  }
  protected readFrom(table: string): string {
    return this.snapshotTs
      ? `${this.qname(table)} AT(TIMESTAMP => TO_TIMESTAMP_TZ('${this.snapshotTs}', 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM'))`
      : this.qname(table);
  }

  async describeExtras(name: string): Promise<TableExtras> {
    const out: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    const rows = await this.query(
      `SELECT column_name, column_default, is_identity
         FROM ${this.quote(this.database)}.information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [this.schema, name],
    );
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
    const db = this.quote(this.database);
    for (const r of await this.query(`SELECT table_name, view_definition FROM ${db}.information_schema.views WHERE table_schema = ? ORDER BY table_name`, [this.schema]))
      out.push({ kind: "view", name: String(r[0]), definition: r[1] === null ? undefined : String(r[1]) });
    for (const r of await this.query(`SELECT sequence_name FROM ${db}.information_schema.sequences WHERE sequence_schema = ? ORDER BY sequence_name`, [this.schema]))
      out.push({ kind: "sequence", name: String(r[0]) });
    for (const r of await this.query(`SELECT function_name FROM ${db}.information_schema.functions WHERE function_schema = ? ORDER BY function_name`, [this.schema]))
      out.push({ kind: "routine", name: String(r[0]), definition: "function" });
    for (const r of await this.query(`SELECT procedure_name FROM ${db}.information_schema.procedures WHERE procedure_schema = ? ORDER BY procedure_name`, [this.schema]))
      out.push({ kind: "routine", name: String(r[0]), definition: "procedure" });
    return out;
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query(
      `SELECT table_name FROM ${this.quote(this.database)}.information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [this.schema],
    );
    return rows.map((r) => String(r[0]));
  }

  async describeTable(name: string): Promise<TableInfo> {
    const cols = await this.query(
      `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable
         FROM ${this.quote(this.database)}.information_schema.columns
        WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [this.schema, name],
    );
    if (cols.length === 0) throw new Error(`Table not found: ${this.database}.${this.schema}.${name}`);
    await this.exec(`SHOW PRIMARY KEYS IN TABLE ${this.qname(name)}`);
    const pk = await this.query(
      `SELECT "column_name", "key_sequence" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))`,
    );
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const columns: ColumnInfo[] = cols.map((r) => {
      const dt = String(r[1]);
      const len = num(r[2]);
      const prec = num(r[3]);
      const scale = num(r[4]);
      return {
        name: String(r[0]),
        nativeType: dt === "NUMBER" ? `NUMBER(${prec},${scale})` : dt === "TEXT" ? `VARCHAR(${len})` : dt,
        nullable: String(r[5]) === "YES",
        ...snowflakeToCanonical(dt, len, prec, scale),
      };
    });
    const primaryKey = pk
      .map((r) => ({ c: String(r[0]), s: Number(r[1]) }))
      .sort((a, b) => a.s - b.s)
      .map((x) => x.c);
    return { name, columns, primaryKey };
  }

  ddlType(c: ColumnInfo): string {
    switch (c.type) {
      case "integer":
        return "INTEGER";
      case "bigint":
        return "BIGINT";
      case "decimal":
        return c.precision !== undefined
          ? `NUMBER(${Math.min(c.precision, 38)},${c.scale ?? 0})`
          : `NUMBER(${this.defaultDecimal.precision},${this.defaultDecimal.scale})`;
      case "float":
        return "FLOAT";
      case "boolean":
        return "BOOLEAN";
      case "string":
        return c.length !== undefined ? `VARCHAR(${Math.min(c.length, 16777216)})` : "VARCHAR";
      case "text":
      case "unknown":
        return "VARCHAR";
      case "date":
        return "DATE";
      case "time":
        return "TIME(6)";
      case "timestamp":
        return "TIMESTAMP_NTZ(6)";
      case "timestamptz":
        return "TIMESTAMP_TZ(6)";
      case "json":
        return "VARIANT";
      case "binary":
        return "BINARY";
      case "uuid":
        return "VARCHAR(36)";
    }
  }
}
