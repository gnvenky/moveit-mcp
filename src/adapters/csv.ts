import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "csv-parse";
import type {
  Adapter,
  Batch,
  ColumnInfo,
  ConnectionConfig,
  DdlOptions,
  ForeignKeyInfo,
  IndexInfo,
  ObjectInventory,
  ReadOptions,
  TableExtras,
  TableInfo,
} from "../types.js";
import { cfgStr, normalizeIdent } from "./base.js";

const BOOL_RE = /^(true|false)$/i;
const INT_RE = /^[+-]?(0|[1-9]\d*)$/;
const DEC_RE = /^[+-]?(\d+\.\d+|\.\d+)$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const TSTZ_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?\s*(Z|[+-]\d{2}(:?\d{2})?)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validDate(s: string): boolean {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Infer a canonical type from a sample of non-null string values. */
export function inferColumn(name: string, values: string[], nullable: boolean): ColumnInfo {
  const base = { name, nullable, nativeType: "csv" };
  if (values.length === 0) return { ...base, type: "string", length: 255 };
  const all = (re: RegExp) => values.every((v) => re.test(v));
  if (all(BOOL_RE)) return { ...base, type: "boolean" };
  if (all(INT_RE)) {
    const big = values.some((v) => {
      const b = BigInt(v);
      return b > 2147483647n || b < -2147483648n;
    });
    const huge = values.some((v) => {
      const b = BigInt(v);
      return b > 9223372036854775807n || b < -9223372036854775808n;
    });
    if (huge) return { ...base, type: "decimal", precision: 38, scale: 0 };
    return { ...base, type: big ? "bigint" : "integer" };
  }
  if (values.every((v) => INT_RE.test(v) || DEC_RE.test(v))) {
    let maxInt = 1;
    let maxScale = 0;
    for (const v of values) {
      const [i, f = ""] = v.replace(/^[+-]/, "").split(".");
      maxInt = Math.max(maxInt, i.replace(/^0+(?=\d)/, "").length);
      maxScale = Math.max(maxScale, f.length);
    }
    const precision = Math.min(38, Math.max(18, maxInt + maxScale));
    return { ...base, type: "decimal", precision, scale: Math.min(maxScale, precision) };
  }
  if (values.every((v) => FLOAT_RE.test(v) || DEC_RE.test(v) || INT_RE.test(v))) return { ...base, type: "float" };
  if (all(DATE_RE) && values.every(validDate)) return { ...base, type: "date" };
  if (all(TSTZ_RE) && values.every(validDate)) return { ...base, type: "timestamptz" };
  if (all(TS_RE) && values.every(validDate)) return { ...base, type: "timestamp" };
  if (all(UUID_RE)) return { ...base, type: "uuid" };
  if (
    values.every((v) => {
      const t = v.trim();
      if (!(t.startsWith("{") || t.startsWith("["))) return false;
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    })
  )
    return { ...base, type: "json" };
  const maxLen = Math.max(...values.map((v) => [...v].length));
  return maxLen > 255 ? { ...base, type: "text" } : { ...base, type: "string", length: 255 };
}

function csvCell(v: unknown, delimiter: string): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (Buffer.isBuffer(v)) s = "0x" + v.toString("hex");
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else s = String(v);
  if (s === "" || s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * CSV as a source (directory of .csv files, or one file) and as a target (directory).
 * Unquoted empty fields are NULL; quoted empty fields ("") are empty strings.
 */
export class CsvAdapter implements Adapter {
  readonly kind = "csv" as const;
  readonly label = "CSV";
  readonly emptyStringIsNull = false;
  readonly maxIdentifierLength = 255;
  readonly supportsPrimaryKey = false;
  readonly enforcesPrimaryKey = false;
  readonly maxDecimalPrecision = 1000;
  readonly supportsIndexes = false;
  readonly supportsDefaults = false;
  readonly supportsIdentity = false;
  readonly foreignKeyMode = "none" as const;

  private readonly path: string;
  private readonly delimiter: string;
  private readonly nullValues: Set<string>;
  private readonly inferRows: number;
  private isFile = false;

  constructor(private readonly cfg: ConnectionConfig) {
    this.path = cfgStr(cfg, "path", true)!;
    this.delimiter = cfgStr(cfg, "delimiter") ?? ",";
    this.nullValues = new Set((cfg.nullValues as string[] | undefined) ?? [""]);
    this.inferRows = Number(cfg.inferRows ?? 10000);
  }

  get readOnly(): boolean {
    return this.cfg.readOnly === true;
  }

  async connect(): Promise<void> {
    if (existsSync(this.path)) this.isFile = statSync(this.path).isFile();
    else if (!this.readOnly && !/\.csv$/i.test(this.path)) mkdirSync(this.path, { recursive: true });
    else if (!existsSync(this.path)) throw new Error(`CSV path does not exist: ${this.path}`);
  }
  async close(): Promise<void> {}
  async ping(): Promise<string> {
    if (!existsSync(this.path)) throw new Error(`CSV path does not exist: ${this.path}`);
    return `CSV: ${this.isFile ? "file" : "directory"} ${this.path}`;
  }

  private fileFor(table: string): string {
    if (/[\\/]/.test(table) || table.startsWith(".") || table === "")
      throw new Error(`Invalid CSV table name: ${table}`);
    if (this.isFile) {
      if (table !== basename(this.path).replace(/\.csv$/i, "")) throw new Error(`Table not found: ${table}`);
      return this.path;
    }
    return join(this.path, `${table}.csv`);
  }

  async listTables(): Promise<string[]> {
    if (!existsSync(this.path)) return [];
    if (this.isFile) return [basename(this.path).replace(/\.csv$/i, "")];
    return readdirSync(this.path)
      .filter((f) => /\.csv$/i.test(f))
      .map((f) => f.replace(/\.csv$/i, ""))
      .sort();
  }
  async tableExists(name: string): Promise<boolean> {
    return existsSync(this.fileFor(name));
  }

  private parser(file: string) {
    return createReadStream(file).pipe(
      parse({
        delimiter: this.delimiter,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: false,
        // unquoted values in nullValues become null; quoted ones stay as text
        cast: (value: string, ctx: { quoting: boolean }) =>
          !ctx.quoting && this.nullValues.has(value) ? null : value,
      }),
    );
  }

  async describeTable(name: string): Promise<TableInfo> {
    const file = this.fileFor(name);
    if (!existsSync(file)) throw new Error(`Table not found: ${name}`);
    let header: string[] | undefined;
    const samples: string[][] = [];
    const nulls: boolean[] = [];
    let n = 0;
    const p = this.parser(file);
    for await (const rec of p as AsyncIterable<(string | null)[]>) {
      if (!header) {
        header = rec.map((h, i) => (h ?? `column_${i + 1}`).trim());
        header.forEach(() => samples.push([]));
        header.forEach(() => nulls.push(false));
        continue;
      }
      rec.forEach((v, i) => {
        if (v === null) nulls[i] = true;
        else samples[i].push(v);
      });
      if (++n >= this.inferRows) {
        p.destroy();
        break;
      }
    }
    if (!header) throw new Error(`CSV file is empty: ${file}`);
    const seen = new Set<string>();
    for (const h of header) {
      if (seen.has(h)) throw new Error(`Duplicate column name "${h}" in ${file}`);
      seen.add(h);
    }
    const columns = header.map((h, i) => inferColumn(h, samples[i], nulls[i] || samples[i].length === 0));
    return { name, columns, primaryKey: [] };
  }

  async countRows(table: string): Promise<number> {
    const file = this.fileFor(table);
    let n = -1; // header
    for await (const _ of this.parser(file)) n++;
    return Math.max(0, n);
  }

  async *readRows(table: string, opts: ReadOptions): AsyncGenerator<Batch> {
    const file = this.fileFor(table);
    let idx: number[] | undefined;
    let seen = 0;
    const skip = opts.cursor?.offset ?? 0;
    let rows: unknown[][] = [];
    let offset = skip;
    for await (const rec of this.parser(file) as AsyncIterable<(string | null)[]>) {
      if (!idx) {
        const header = rec.map((h, i) => (h ?? `column_${i + 1}`).trim());
        idx = opts.columns.map((c) => {
          const k = header.indexOf(c);
          if (k === -1) throw new Error(`Column ${c} not found in ${file}`);
          return k;
        });
        continue;
      }
      if (seen++ < skip) continue;
      rows.push(idx.map((k) => rec[k] ?? null));
      offset++;
      if (rows.length >= opts.batchSize) {
        yield { rows, cursor: { offset } };
        rows = [];
      }
    }
    if (rows.length) yield { rows, cursor: { offset } };
  }

  normalizeIdentifier(name: string): string {
    return normalizeIdent(name, "preserve");
  }
  isReservedWord(): boolean {
    return false;
  }

  ddlFor(table: TableInfo, _opts?: DdlOptions): string {
    return `CSV file ${table.name}.csv with header: ${table.columns.map((c) => c.name).join(delimiterLabel(this.delimiter))}`;
  }

  private assertWritable(op: string): void {
    if (this.readOnly) throw new Error(`Connection is marked readOnly; refusing to ${op}.`);
    if (this.isFile) throw new Error(`CSV target must be a directory, but ${this.path} is a file.`);
  }

  async createTable(table: TableInfo): Promise<void> {
    this.assertWritable(`create ${table.name}.csv`);
    const file = this.fileFor(table.name);
    if (existsSync(file)) throw new Error(`File already exists: ${file}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, table.columns.map((c) => csvCell(c.name, this.delimiter)).join(this.delimiter) + "\n", { flag: "wx" });
  }

  async insertRows(table: TableInfo, columns: string[], rows: unknown[][]): Promise<void> {
    this.assertWritable(`write to ${table.name}.csv`);
    const expected = table.columns.map((c) => c.name);
    if (columns.length !== expected.length || columns.some((c, i) => c !== expected[i]))
      throw new Error("CSV targets require columns in table order.");
    const text = rows.map((r) => r.map((v) => csvCell(v, this.delimiter)).join(this.delimiter)).join("\n");
    if (text) appendFileSync(this.fileFor(table.name), text + "\n");
  }

  async renameTable(from: string, to: string): Promise<void> {
    this.assertWritable(`rename ${from}.csv`);
    const dest = this.fileFor(to);
    if (existsSync(dest)) throw new Error(`File already exists: ${dest}`);
    renameSync(this.fileFor(from), dest);
  }
  async dropTable(name: string): Promise<void> {
    this.assertWritable(`delete ${name}.csv`);
    const f = this.fileFor(name);
    if (existsSync(f)) unlinkSync(f);
  }
  async countDuplicateKeys(table: string, keys: string[]): Promise<number> {
    const file = this.fileFor(table);
    if (!existsSync(file)) return 0;
    const seen = new Map<string, number>();
    let idx: number[] | undefined;
    for await (const rec of this.parser(file) as AsyncIterable<(string | null)[]>) {
      if (!idx) {
        const header = rec.map((h, i) => (h ?? `column_${i + 1}`).trim());
        idx = keys.map((k) => {
          const i = header.indexOf(k);
          if (i === -1) throw new Error(`Column ${k} not found in ${file}`);
          return i;
        });
        continue;
      }
      const key = JSON.stringify(idx.map((i) => rec[i]));
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    let dupes = 0;
    for (const n of seen.values()) if (n > 1) dupes++;
    return dupes;
  }
  maxInsertRows(): number {
    return 5000;
  }

  // Files have no indexes, keys, defaults or snapshots. Append is refused by the planner for CSV targets.
  async beginSnapshot(): Promise<boolean> {
    return false;
  }
  async endSnapshot(): Promise<void> {}
  async describeExtras(_table: string): Promise<TableExtras> {
    return { indexes: [], foreignKeys: [], defaults: {}, notes: [] };
  }
  async listObjects(): Promise<ObjectInventory[]> {
    return [];
  }
  async maxValue(): Promise<string | null> {
    return null;
  }
  async createIndex(_t: string, _i: IndexInfo): Promise<void> {
    throw new Error("CSV files have no indexes.");
  }
  async addForeignKey(_t: string, _f: ForeignKeyInfo): Promise<void> {
    throw new Error("CSV files have no foreign keys.");
  }
  async dropForeignKey(): Promise<void> {}
  async insertFromTable(): Promise<void> {
    throw new Error("Append is not supported for CSV targets.");
  }
  async countKeyCollisions(): Promise<number> {
    throw new Error("Append is not supported for CSV targets.");
  }
  async deleteMatchingKeys(): Promise<void> {
    throw new Error("Append is not supported for CSV targets.");
  }
}

function delimiterLabel(d: string): string {
  return d === "\t" ? "\t" : `${d} `;
}

