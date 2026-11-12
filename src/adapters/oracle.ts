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

type Mapped = { type: CanonicalType; length?: number; precision?: number; scale?: number };

/** Map an ALL_TAB_COLUMNS row to a canonical type. */
export function oracleToCanonical(
  dataType: string,
  charLength: number | null,
  precision: number | null,
  scale: number | null,
): Mapped {
  const t = dataType.toUpperCase();
  if (t === "NUMBER") {
    if (precision === null && scale === null) return { type: "decimal" };
    if (precision === null && scale === 0) return { type: "bigint" }; // NUMBER(*,0)
    const p = precision ?? 38;
    const s = scale ?? 0;
    if (s === 0) {
      if (p <= 9) return { type: "integer" };
      if (p <= 18 || p === 38) return { type: "bigint" }; // NUMBER(38) is Oracle's "any integer"; the dry run checks real values
      return { type: "decimal", precision: p, scale: 0 };
    }
    if (s < 0) return { type: "decimal", precision: p - s, scale: 0 };
    return { type: "decimal", precision: p, scale: s };
  }
  if (t === "FLOAT" || t === "BINARY_FLOAT" || t === "BINARY_DOUBLE") return { type: "float" };
  if (t === "VARCHAR2" || t === "NVARCHAR2" || t === "CHAR" || t === "NCHAR" || t === "VARCHAR")
    return charLength ? { type: "string", length: charLength } : { type: "string" };
  if (t === "CLOB" || t === "NCLOB" || t === "LONG") return { type: "text" };
  if (t === "BLOB" || t === "RAW" || t === "LONG RAW") return { type: "binary" };
  if (t === "DATE") return { type: "timestamp" }; // Oracle DATE carries a time of day
  if (t.startsWith("TIMESTAMP")) return /WITH (LOCAL )?TIME ZONE/.test(t) ? { type: "timestamptz" } : { type: "timestamp" };
  if (t === "JSON") return { type: "json" };
  if (t === "BOOLEAN") return { type: "boolean" };
  return { type: "unknown" };
}

const ORACLE_EXTRA_RESERVED = new Set(
  "access audit cluster compress connect current exclusive file identified immediate increment initial intersect long lock maxextents minus mode modify noaudit nocompress nowait online option pctfree prior public raw rename resource revoke row rowid rownum rows share successful synonym sysdate trigger validate varchar varchar2 whenever".split(" "),
);

const TS_FMT = "YYYY-MM-DD\"T\"HH24:MI:SS.FF6";
const TSTZ_FMT = "YYYY-MM-DD HH24:MI:SS.FF6TZH:TZM";

export class OracleAdapter extends SqlAdapter {
  readonly kind = "oracle" as const;
  readonly label = "Oracle";
  emptyStringIsNull = true;
  maxIdentifierLength = 128;
  maxDecimalPrecision = 38;
  maxStringBytes = 4000;
  protected identifierCase = "upper" as const;
  protected transactional = false; // transactions are implicit; commit/rollback are driver calls
  protected maxParams = 30000;
  private ora: any;
  private conn: any;
  private owner = "";
  private inSnapshot = false;

  constructor(cfg: ConnectionConfig) {
    super(cfg);
  }

  async connect(): Promise<void> {
    this.ora = await lazyImport<any>("oracledb");
    this.ora.fetchAsString = []; // we cast explicitly in SQL; keep driver defaults otherwise
    const url = cfgStr(this.cfg, "connectString") ?? cfgStr(this.cfg, "url", true);
    this.conn = await this.ora.getConnection({
      user: cfgStr(this.cfg, "user"),
      password: cfgStr(this.cfg, "password"),
      connectString: url,
      ...(this.cfg.walletLocation ? { walletLocation: cfgStr(this.cfg, "walletLocation") } : {}),
      ...(this.cfg.walletPassword ? { walletPassword: cfgStr(this.cfg, "walletPassword") } : {}),
    });
    for (const stmt of [
      "ALTER SESSION SET TIME_ZONE = 'UTC'",
      "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6'",
      `ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = '${TSTZ_FMT}'`,
    ])
      await this.conn.execute(stmt);
    this.owner = (cfgStr(this.cfg, "schema") ?? "").toUpperCase();
    if (!this.owner) {
      const r = await this.query("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
      this.owner = String(r[0][0]);
    }
  }
  async close(): Promise<void> {
    await this.conn?.close();
    this.conn = undefined;
  }

  protected schemaParts(): string[] {
    return [this.owner];
  }
  quote(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }
  placeholder(i: number): string {
    return `:${i}`;
  }
  protected pingSql(): string {
    return "SELECT 1 FROM DUAL";
  }
  protected page(limit: number, offset: number): string {
    return `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  isReservedWord(name: string): boolean {
    return super.isReservedWord(name) || ORACLE_EXTRA_RESERVED.has(name.toLowerCase());
  }

  private fetchTypeHandler = (m: any) => {
    const o = this.ora;
    if (m.dbType === o.DB_TYPE_CLOB || m.dbType === o.DB_TYPE_NCLOB) return { type: o.STRING };
    if (m.dbType === o.DB_TYPE_BLOB) return { type: o.BUFFER };
    return undefined;
  };

  async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const res = await this.conn.execute(sql, params, {
      outFormat: this.ora.OUT_FORMAT_ARRAY,
      fetchTypeHandler: this.fetchTypeHandler,
    });
    return res.rows ?? [];
  }
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.conn.execute(sql, params, { autoCommit: false });
  }
  protected async begin(): Promise<void> {}
  protected async commit(): Promise<void> {
    await this.conn.commit();
  }
  protected async rollback(): Promise<void> {
    await this.conn.rollback();
  }

  protected selectExpr(col: ColumnInfo): string {
    const q = this.quote(col.name);
    switch (col.type) {
      case "integer":
      case "bigint":
      case "decimal":
        return col.nativeType.toUpperCase().startsWith("NUMBER")
          ? `TO_CHAR(${q}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')`
          : q;
      case "timestamp":
        return /^DATE/i.test(col.nativeType)
          ? `TO_CHAR(${q}, 'YYYY-MM-DD"T"HH24:MI:SS')`
          : `TO_CHAR(${q}, '${TS_FMT}')`;
      case "timestamptz":
        return `TO_CHAR(${q} AT TIME ZONE 'UTC', '${TS_FMT}')`;
      default:
        return q;
    }
  }

  placeholderFor(col: ColumnInfo, i: number): string {
    const ph = `:${i}`;
    switch (col.type) {
      case "integer":
      case "bigint":
      case "decimal":
        return `TO_NUMBER(${ph})`;
      case "date":
        return `TO_DATE(${ph}, 'YYYY-MM-DD')`;
      case "timestamp":
        return `TO_TIMESTAMP(${ph}, 'YYYY-MM-DD HH24:MI:SS.FF6')`;
      case "timestamptz":
        return `TO_TIMESTAMP_TZ(${ph}, '${TSTZ_FMT}')`;
      default:
        return ph;
    }
  }

  protected bind(v: unknown, col: ColumnInfo): unknown {
    if (v === null || v === undefined) return null;
    if (col.type === "boolean") return v ? 1 : 0;
    if (col.type === "integer" || col.type === "bigint") return String(v);
    if (col.type === "json" && typeof v !== "string") return JSON.stringify(v);
    return v;
  }

  /** Oracle has no multi-row VALUES before 23ai, so use executeMany with explicit bind definitions. */
  async insertRows(table: TableInfo, columns: string[], rows: unknown[][]): Promise<void> {
    this.assertWritable(`insert into ${table.name}`);
    if (rows.length === 0) return;
    const infos = columns.map((n) => {
      const c = table.columns.find((x) => x.name === n);
      if (!c) throw new Error(`Column ${n} not found in ${table.name}`);
      return c;
    });
    const sql = `INSERT INTO ${this.qname(table.name)} (${infos.map((c) => this.quote(c.name)).join(", ")}) VALUES (${infos
      .map((c, j) => this.placeholderFor(c, j + 1))
      .join(", ")})`;
    const o = this.ora;
    const chunk = 5000;
    try {
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk).map((r) => r.map((v, j) => this.bind(v, infos[j])));
        const bindDefs = infos.map((c, j) => {
          switch (c.type) {
            case "float":
              return { type: o.DB_TYPE_BINARY_DOUBLE };
            case "boolean":
              return { type: o.NUMBER };
            case "binary":
              return { type: o.BUFFER, maxSize: Math.max(1, ...slice.map((r) => (r[j] as Buffer | null)?.length ?? 0)) };
            default:
              return {
                type: o.STRING,
                maxSize: Math.max(1, ...slice.map((r) => Buffer.byteLength(String(r[j] ?? "")))),
              };
          }
        });
        await this.conn.executeMany(sql, slice, { bindDefs, autoCommit: false });
      }
      await this.conn.commit();
    } catch (e) {
      try {
        await this.conn.rollback();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  protected dropSql(name: string): string {
    return `DROP TABLE ${this.qname(name)} PURGE`;
  }

  protected identityClause(c: ColumnInfo): string {
    const start = c.identity?.start ?? "1";
    if (!/^\d+$/.test(start)) throw new Error(`Invalid identity start value: ${start}`);
    return ` GENERATED BY DEFAULT AS IDENTITY (START WITH ${start})`;
  }
  protected boolLiteral(b: boolean): string {
    return b ? "1" : "0";
  }
  /** Oracle has ON DELETE CASCADE / SET NULL and nothing for ON UPDATE. */
  protected fkActionSql(fk: ForeignKeyInfo): string {
    return fk.onDelete === "CASCADE" || fk.onDelete === "SET NULL" ? ` ON DELETE ${fk.onDelete}` : "";
  }
  /** Index names live in the owner's schema, which is not necessarily the login user's. */
  protected indexNameSql(name: string): string {
    return `${this.quote(this.owner)}.${this.quote(name)}`;
  }
  async maxValue(table: string, column: string): Promise<string | null> {
    const rows = await this.query(`SELECT TO_CHAR(MAX(${this.quote(column)}), 'TM9') FROM ${this.qname(table)}`);
    const v = rows[0]?.[0];
    return v === null || v === undefined ? null : String(v);
  }

  /** A read-only transaction sees the database as of its first statement until it ends. Long runs need enough undo. */
  async beginSnapshot(): Promise<boolean> {
    if (this.inSnapshot) return true;
    await this.conn.commit();
    await this.conn.execute("SET TRANSACTION READ ONLY");
    this.inSnapshot = true;
    return true;
  }
  async endSnapshot(): Promise<void> {
    if (!this.inSnapshot) return;
    this.inSnapshot = false;
    await this.conn.commit();
  }

  async describeExtras(name: string): Promise<TableExtras> {
    const out: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    const o = this.owner;
    const cols = await this.query(
      "SELECT column_name, data_default FROM all_tab_columns WHERE owner = :1 AND table_name = :2 AND data_default IS NOT NULL AND virtual_column = 'NO'",
      [o, name],
    );
    for (const r of cols) {
      const col = String(r[0]);
      const raw = String(r[1]).trim();
      if (/\.nextval$/i.test(raw) || /^"?ISEQ\$\$/i.test(raw)) continue; // sequence-backed; identity is read below
      const d = parseDefault(raw);
      if (d.value) out.defaults[col] = d.value as DefaultValue;
      else if (d.unsupported) out.notes.push(`Column ${col}: default ${d.unsupported} is not portable and was not migrated.`);
    }
    try {
      const ident = await this.query("SELECT column_name FROM all_tab_identity_cols WHERE owner = :1 AND table_name = :2", [o, name]);
      if (ident.length === 1) {
        out.identity = String(ident[0][0]);
        delete out.defaults[out.identity];
      } else if (ident.length > 1) out.notes.push(`Several identity columns: ${ident.map((r) => r[0]).join(", ")}`);
    } catch {
      /* identity columns need Oracle 12c+ */
    }

    const idx = await this.query(
      `SELECT i.index_name, i.uniqueness, i.index_type, c.column_name, c.column_position
         FROM all_indexes i
         JOIN all_ind_columns c ON c.index_owner = i.owner AND c.index_name = i.index_name
        WHERE i.table_owner = :1 AND i.table_name = :2
          AND i.index_name NOT IN (SELECT index_name FROM all_constraints WHERE owner = :3 AND table_name = :4 AND constraint_type = 'P' AND index_name IS NOT NULL)
        ORDER BY i.index_name, c.column_position`,
      [o, name, o, name],
    );
    const byIdx = new Map<string, unknown[][]>();
    for (const r of idx) byIdx.set(String(r[0]), [...(byIdx.get(String(r[0])) ?? []), r]);
    for (const [iname, parts] of byIdx) {
      const type = String(parts[0][2]);
      if (type === "LOB") continue;
      if (type !== "NORMAL") out.notes.push(`Index ${iname}: ${type.toLowerCase()} indexes are not migrated.`);
      else if (parts.some((p) => /^SYS_NC/i.test(String(p[3])))) out.notes.push(`Index ${iname}: function-based indexes are not migrated.`);
      else out.indexes.push({ name: iname, columns: parts.map((p) => String(p[3])), unique: String(parts[0][1]) === "UNIQUE" });
    }

    const fk = await this.query(
      `SELECT c.constraint_name, cc.column_name, rc.table_name, rcc.column_name, c.delete_rule, c.r_owner
         FROM all_constraints c
         JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
         JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
         JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
        WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R'
        ORDER BY c.constraint_name, cc.position`,
      [o, name],
    );
    const byFk = new Map<string, unknown[][]>();
    for (const r of fk) byFk.set(String(r[0]), [...(byFk.get(String(r[0])) ?? []), r]);
    for (const [fname, parts] of byFk) {
      if (String(parts[0][5]) !== o) {
        out.notes.push(`Foreign key ${fname}: references another schema, which is not migrated.`);
        continue;
      }
      const rule = String(parts[0][4]).toUpperCase();
      out.foreignKeys.push({
        name: fname,
        columns: parts.map((p) => String(p[1])),
        refTable: String(parts[0][2]),
        refColumns: parts.map((p) => String(p[3])),
        onDelete: (rule === "CASCADE" || rule === "SET NULL" ? rule : "NO ACTION") as FkAction,
      });
    }
    return out;
  }

  async listObjects(): Promise<ObjectInventory[]> {
    const out: ObjectInventory[] = [];
    const o = this.owner;
    for (const r of await this.query("SELECT view_name FROM all_views WHERE owner = :1 ORDER BY view_name", [o]))
      out.push({ kind: "view", name: String(r[0]) });
    for (const r of await this.query("SELECT trigger_name, table_name FROM all_triggers WHERE owner = :1 ORDER BY trigger_name", [o]))
      out.push({ kind: "trigger", name: String(r[0]), table: String(r[1]) });
    for (const r of await this.query("SELECT sequence_name FROM all_sequences WHERE sequence_owner = :1 AND sequence_name NOT LIKE 'ISEQ$$%' ORDER BY sequence_name", [o]))
      out.push({ kind: "sequence", name: String(r[0]) });
    for (const r of await this.query(
      "SELECT object_name, object_type FROM all_objects WHERE owner = :1 AND object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE') ORDER BY object_name",
      [o],
    ))
      out.push({ kind: "routine", name: String(r[0]), definition: String(r[1]).toLowerCase() });
    return out;
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query(
      "SELECT table_name FROM all_tables WHERE owner = :1 AND nested = 'NO' AND iot_name IS NULL ORDER BY table_name",
      [this.owner],
    );
    return rows.map((r) => String(r[0]));
  }

  async describeTable(name: string): Promise<TableInfo> {
    const cols = await this.query(
      `SELECT column_name, data_type, data_length, char_length, data_precision, data_scale, nullable
         FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id`,
      [this.owner, name],
    );
    if (cols.length === 0) throw new Error(`Table not found: ${this.owner}.${name}`);
    const pk = await this.query(
      `SELECT cc.column_name
         FROM all_constraints c
         JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
        WHERE c.constraint_type = 'P' AND c.owner = :1 AND c.table_name = :2
        ORDER BY cc.position`,
      [this.owner, name],
    );
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const columns: ColumnInfo[] = cols.map((r) => {
      const dt = String(r[1]);
      const prec = num(r[4]);
      const scale = num(r[5]);
      const len = num(r[3]);
      const native =
        dt === "NUMBER" && prec !== null
          ? `NUMBER(${prec}${scale ? "," + scale : ""})`
          : /CHAR/.test(dt) && len
            ? `${dt}(${len})`
            : dt;
      return {
        name: String(r[0]),
        nativeType: native,
        nullable: String(r[6]) === "Y",
        ...oracleToCanonical(dt, len, prec, scale),
      };
    });
    return { name, columns, primaryKey: pk.map((r) => String(r[0])) };
  }

  ddlType(c: ColumnInfo, isPk: boolean): string {
    switch (c.type) {
      case "integer":
        return "NUMBER(10,0)";
      case "bigint":
        return "NUMBER(19,0)";
      case "decimal":
        if (c.precision === undefined) return "NUMBER";
        return `NUMBER(${Math.min(c.precision, 38)},${c.scale ?? 0})`;
      case "float":
        return "BINARY_DOUBLE";
      case "boolean":
        return "NUMBER(1,0)";
      case "string":
        return c.length !== undefined && c.length <= 4000 ? `VARCHAR2(${c.length} CHAR)` : isPk ? "VARCHAR2(1000 CHAR)" : "CLOB";
      case "text":
      case "unknown":
        return isPk ? "VARCHAR2(1000 CHAR)" : "CLOB";
      case "date":
        return "DATE";
      case "time":
        return "VARCHAR2(15 CHAR)"; // Oracle has no TIME type
      case "timestamp":
        return "TIMESTAMP(6)";
      case "timestamptz":
        return "TIMESTAMP(6) WITH TIME ZONE";
      case "json":
        return `CLOB CHECK (${this.quote(c.name)} IS JSON)`;
      case "binary":
        return isPk ? "RAW(2000)" : "BLOB";
      case "uuid":
        return "VARCHAR2(36 CHAR)";
    }
  }
}
