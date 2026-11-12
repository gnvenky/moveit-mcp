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
import { SqlAdapter, cfgStr, lazyImport } from "./base.js";
import { parseDefault } from "./defaults.js";

const PG_FK_ACTION: Record<string, FkAction> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

export function pgToCanonical(
  dataType: string,
  udt: string,
  len: number | null,
  prec: number | null,
  scale: number | null,
): { type: CanonicalType; length?: number; precision?: number; scale?: number } {
  const t = dataType.toLowerCase();
  switch (t) {
    case "integer":
    case "smallint":
      return { type: "integer" };
    case "bigint":
      return { type: "bigint" };
    case "numeric":
    case "decimal":
      return prec !== null ? { type: "decimal", precision: prec, scale: scale ?? 0 } : { type: "decimal" };
    case "real":
    case "double precision":
      return { type: "float" };
    case "boolean":
      return { type: "boolean" };
    case "character varying":
    case "character":
      return len !== null ? { type: "string", length: len } : { type: "string" };
    case "text":
    case "citext":
      return { type: "text" };
    case "date":
      return { type: "date" };
    case "time without time zone":
    case "time with time zone":
      return { type: "time" };
    case "timestamp without time zone":
      return { type: "timestamp" };
    case "timestamp with time zone":
      return { type: "timestamptz" };
    case "json":
    case "jsonb":
      return { type: "json" };
    case "bytea":
      return { type: "binary" };
    case "uuid":
      return { type: "uuid" };
    case "array":
      return { type: "json" };
    case "user-defined":
      return udt === "citext" ? { type: "text" } : { type: "string" }; // enums and extension types come back as text
    default:
      return { type: "unknown" };
  }
}

export class PostgresAdapter extends SqlAdapter {
  readonly kind = "postgres" as const;
  readonly label = "PostgreSQL";
  protected maxParams = 60000;
  maxIdentifierLength = 63;
  private client: any;
  private inSnapshot = false;

  constructor(cfg: ConnectionConfig) {
    super(cfg);
  }

  private get schema(): string {
    return cfgStr(this.cfg, "schema") ?? "public";
  }
  protected schemaParts(): string[] {
    return [this.schema];
  }

  async connect(): Promise<void> {
    const pg = await lazyImport<any>("pg");
    const url = cfgStr(this.cfg, "url");
    const rawTemporal = new Set([1082, 1114, 1184]); // date, timestamp, timestamptz stay as strings
    this.client = new pg.Client({
      types: {
        getTypeParser: (oid: number, format?: string) =>
          rawTemporal.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format),
      },
      ...(url
        ? { connectionString: url }
        : {
            host: cfgStr(this.cfg, "host", true),
            port: Number(cfgStr(this.cfg, "port") ?? 5432),
            user: cfgStr(this.cfg, "user"),
            password: cfgStr(this.cfg, "password"),
            database: cfgStr(this.cfg, "database", true),
          }),
      ...(this.cfg.ssl !== undefined ? { ssl: this.cfg.ssl } : {}),
      ...(this.readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    await this.client.connect();
    await this.client.query("SET TIME ZONE 'UTC'");
  }
  async close(): Promise<void> {
    this.inSnapshot = false;
    await this.client?.end();
    this.client = undefined;
  }

  quote(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }
  placeholder(i: number): string {
    return `$${i}`;
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const res = await this.client.query({ text: sql, values: params, rowMode: "array" });
    return res.rows;
  }
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.client.query(params.length ? { text: sql, values: params } : sql);
  }

  async listTables(): Promise<string[]> {
    const rows = await this.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      [this.schema],
    );
    return rows.map((r) => String(r[0]));
  }

  async describeTable(name: string): Promise<TableInfo> {
    const cols = await this.query(
      `SELECT column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [this.schema, name],
    );
    if (cols.length === 0) throw new Error(`Table not found: ${this.schema}.${name}`);
    const pk = await this.query(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [this.qname(name)],
    );
    const columns: ColumnInfo[] = cols.map((r) => ({
      name: String(r[0]),
      nativeType: String(r[1]) === "USER-DEFINED" ? String(r[2]) : String(r[1]),
      nullable: String(r[3]) === "YES",
      ...pgToCanonical(
        String(r[1]),
        String(r[2]),
        r[4] === null ? null : Number(r[4]),
        r[5] === null ? null : Number(r[5]),
        r[6] === null ? null : Number(r[6]),
      ),
    }));
    return { name, columns, primaryKey: pk.map((r) => String(r[0])) };
  }

  protected identityClause(c: ColumnInfo): string {
    const start = c.identity?.start ?? "1";
    if (!/^\d+$/.test(start)) throw new Error(`Invalid identity start value: ${start}`);
    return ` GENERATED BY DEFAULT AS IDENTITY (START WITH ${start})`;
  }

  /** One repeatable-read, read-only transaction: every table is read as of the same instant. */
  async beginSnapshot(): Promise<boolean> {
    if (this.inSnapshot) return true;
    await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    this.inSnapshot = true;
    await this.client.query("SELECT 1"); // the snapshot is taken by the first statement
    return true;
  }
  async endSnapshot(): Promise<void> {
    if (!this.inSnapshot) return;
    this.inSnapshot = false;
    await this.client.query("COMMIT");
  }

  async describeExtras(name: string): Promise<TableExtras> {
    const out: TableExtras = { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
    const cols = await this.query(
      `SELECT column_name, column_default, is_identity, is_generated
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [this.schema, name],
    );
    const identities: string[] = [];
    for (const r of cols) {
      const col = String(r[0]);
      const def = r[1] === null ? null : String(r[1]);
      if (String(r[3]) === "ALWAYS") {
        out.notes.push(`Column ${col}: generated column; its values are copied but the expression is not.`);
        continue;
      }
      if (String(r[2]) === "YES" || (def !== null && /^nextval\(/i.test(def))) {
        identities.push(col);
        continue;
      }
      if (def === null) continue;
      const d = parseDefault(def);
      if (d.value) out.defaults[col] = d.value as DefaultValue;
      else if (d.unsupported) out.notes.push(`Column ${col}: default ${d.unsupported} is not portable and was not migrated.`);
    }
    if (identities.length === 1) out.identity = identities[0];
    else if (identities.length > 1) out.notes.push(`Several auto-generated columns (${identities.join(", ")}); none were migrated as identity.`);

    const attnames = await this.attnameMap(name);
    const idx = await this.query(
      `SELECT ic.relname, i.indisunique, (i.indpred IS NOT NULL), i.indkey::text, i.indnkeyatts, i.indnatts, am.amname
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_am am ON am.oid = ic.relam
        WHERE i.indrelid = $1::regclass AND NOT i.indisprimary
        ORDER BY ic.relname`,
      [this.qname(name)],
    );
    for (const r of idx) {
      const iname = String(r[0]);
      const keys = String(r[3]).split(" ").map(Number);
      const nkey = Number(r[4]);
      if (r[2] === true) out.notes.push(`Index ${iname}: partial indexes are not migrated.`);
      else if (String(r[6]) !== "btree") out.notes.push(`Index ${iname}: ${r[6]} indexes are not migrated.`);
      else if (keys.slice(0, nkey).some((k) => k === 0)) out.notes.push(`Index ${iname}: expression indexes are not migrated.`);
      else {
        out.indexes.push({
          name: iname,
          columns: keys.slice(0, nkey).map((k) => attnames.get(k) ?? ""),
          unique: r[1] === true,
        });
        if (Number(r[5]) > nkey) out.notes.push(`Index ${iname}: INCLUDE columns were dropped.`);
      }
    }

    const fks = await this.query(
      `SELECT c.conname, c.confupdtype, c.confdeltype, array_to_string(c.conkey, ','), array_to_string(c.confkey, ','),
              rc.relname, rn.nspname, c.confrelid::int8
         FROM pg_constraint c
         JOIN pg_class rc ON rc.oid = c.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE c.conrelid = $1::regclass AND c.contype = 'f'
        ORDER BY c.conname`,
      [this.qname(name)],
    );
    for (const r of fks) {
      if (String(r[6]) !== this.schema) {
        out.notes.push(`Foreign key ${r[0]}: references a table in schema ${r[6]}, which is not migrated.`);
        continue;
      }
      const refNames = await this.attnameMapByOid(String(r[7]));
      out.foreignKeys.push({
        name: String(r[0]),
        columns: String(r[3]).split(",").map((k) => attnames.get(Number(k)) ?? ""),
        refTable: String(r[5]),
        refColumns: String(r[4]).split(",").map((k) => refNames.get(Number(k)) ?? ""),
        onUpdate: PG_FK_ACTION[String(r[1])],
        onDelete: PG_FK_ACTION[String(r[2])],
      });
    }
    return out;
  }

  /** Move a serial/identity counter past the highest value in the column (setval handles both kinds). */
  async syncIdentity(table: string, column: string): Promise<void> {
    this.assertWritable(`reset the counter of ${table}.${column}`);
    await this.exec(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(m.mx, 1), m.mx IS NOT NULL)
         FROM (SELECT MAX(${this.quote(column)}) AS mx FROM ${this.qname(table)}) m`,
      [this.qname(table), column],
    );
  }

  private async attnameMap(table: string): Promise<Map<number, string>> {
    const rows = await this.query(
      "SELECT attnum, attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped",
      [this.qname(table)],
    );
    return new Map(rows.map((r) => [Number(r[0]), String(r[1])]));
  }
  private async attnameMapByOid(oid: string): Promise<Map<number, string>> {
    const rows = await this.query(
      "SELECT attnum, attname FROM pg_attribute WHERE attrelid = $1::int8::oid AND attnum > 0 AND NOT attisdropped",
      [oid],
    );
    return new Map(rows.map((r) => [Number(r[0]), String(r[1])]));
  }

  async listObjects(): Promise<ObjectInventory[]> {
    const out: ObjectInventory[] = [];
    const views = await this.query("SELECT viewname, definition FROM pg_views WHERE schemaname = $1 ORDER BY viewname", [this.schema]);
    for (const r of views) out.push({ kind: "view", name: String(r[0]), definition: String(r[1]).trim() });
    const mviews = await this.query("SELECT matviewname, definition FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname", [this.schema]);
    for (const r of mviews) out.push({ kind: "view", name: String(r[0]), definition: String(r[1]).trim() });
    const trig = await this.query(
      `SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
      [this.schema],
    );
    for (const r of trig) out.push({ kind: "trigger", name: String(r[0]), table: String(r[1]) });
    const seqs = await this.query(
      `SELECT s.sequencename FROM pg_sequences s
        WHERE s.schemaname = $1
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass
                             AND d.deptype IN ('a', 'i'))
        ORDER BY s.sequencename`,
      [this.schema],
    );
    for (const r of seqs) out.push({ kind: "sequence", name: String(r[0]) });
    const routines = await this.query(
      "SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema = $1 ORDER BY routine_name",
      [this.schema],
    );
    for (const r of routines) out.push({ kind: "routine", name: String(r[0]), definition: String(r[1]).toLowerCase() });
    return out;
  }

  ddlType(c: ColumnInfo): string {
    switch (c.type) {
      case "integer":
        return "INTEGER";
      case "bigint":
        return "BIGINT";
      case "decimal":
        return c.precision !== undefined ? `NUMERIC(${c.precision},${c.scale ?? 0})` : "NUMERIC";
      case "float":
        return "DOUBLE PRECISION";
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
        return "JSONB";
      case "binary":
        return "BYTEA";
      case "uuid":
        return "UUID";
    }
  }
}
