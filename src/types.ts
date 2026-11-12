// Shared types for moveit-mcp.

export type DbKind =
  | "sqlite"
  | "postgres"
  | "mysql"
  | "oracle"
  | "snowflake"
  | "databricks"
  | "csv";

/** Dialect-neutral column types every adapter maps to and from. */
export type CanonicalType =
  | "integer" // 32-bit
  | "bigint" // 64-bit
  | "decimal"
  | "float"
  | "boolean"
  | "string" // bounded or unbounded varchar
  | "text" // large text / CLOB
  | "date"
  | "time"
  | "timestamp" // no time zone
  | "timestamptz" // with time zone (normalised to UTC)
  | "json"
  | "binary"
  | "uuid"
  | "unknown";

export const CANONICAL_TYPES: CanonicalType[] = [
  "integer",
  "bigint",
  "decimal",
  "float",
  "boolean",
  "string",
  "text",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "json",
  "binary",
  "uuid",
  "unknown",
];

/** Only portable defaults are migrated: plain literals, and "now" / "today". Everything else is reported. */
export type DefaultValue =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "now" }
  | { kind: "today" };

export interface ColumnInfo {
  name: string;
  nativeType: string;
  type: CanonicalType;
  nullable: boolean;
  default?: DefaultValue;
  /** Auto-generated key column. `start` is the next value to hand out (max existing + 1). */
  identity?: { start: string };
  /** Max characters for string columns, when bounded. */
  length?: number;
  precision?: number;
  scale?: number;
}

export type FkAction = "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" | "SET DEFAULT";

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
}

/** Things a source table has beyond columns and its primary key, as far as the adapter can read them. */
export interface TableExtras {
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  defaults: Record<string, DefaultValue>;
  /** Single auto-generated key column, if any. */
  identity?: string;
  /** Things that exist but cannot be migrated (expression indexes, non-portable defaults, ...). */
  notes: string[];
}

export interface ObjectInventory {
  kind: "view" | "trigger" | "sequence" | "routine" | "other";
  name: string;
  table?: string;
  definition?: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
}

export type Cursor = { offset: number; lastKey?: unknown };

export interface Batch {
  /** Rows aligned to the `columns` requested from readRows. */
  rows: unknown[][];
  /** Cursor to resume *after* this batch. */
  cursor: Cursor;
}

export interface ReadOptions {
  columns: string[];
  batchSize: number;
  cursor?: Cursor;
}

export interface ConnectionConfig {
  type: DbKind;
  /** Refuse any write through this connection. Strongly recommended for sources. */
  readOnly?: boolean;
  [key: string]: unknown;
}

export interface DdlOptions {
  withPrimaryKey?: boolean;
  pkName?: string;
  /** Only used by systems that must declare foreign keys inside CREATE TABLE (SQLite). */
  foreignKeys?: ForeignKeyInfo[];
}

export interface Adapter {
  readonly kind: DbKind;
  readonly label: string;
  readonly readOnly: boolean;
  /** Oracle (and CSV without quoting) cannot tell '' from NULL. The engine accounts for it. */
  readonly emptyStringIsNull: boolean;
  readonly maxIdentifierLength: number;
  readonly supportsPrimaryKey: boolean;
  /** Snowflake and Databricks accept PRIMARY KEY but do not enforce it. */
  readonly enforcesPrimaryKey: boolean;
  /** Largest DECIMAL precision this system supports. */
  readonly maxDecimalPrecision: number;
  /** Used when a source DECIMAL has no precision and the target has no unbounded numeric. */
  readonly defaultDecimal?: { precision: number; scale: number };
  /** Systems that bound VARCHAR in bytes rather than characters. */
  readonly maxStringBytes?: number;

  /** Preferred rows per batch when no explicit batch size is given (bulk loaders want large batches). */
  readonly preferredBatchSize?: number;
  readonly supportsIndexes: boolean;
  readonly supportsDefaults: boolean;
  /** Whether auto-generated key columns can be created here. */
  readonly supportsIdentity: boolean;
  /** "inline": must be part of CREATE TABLE; "alter": ALTER TABLE ADD CONSTRAINT; "none": unsupported. */
  readonly foreignKeyMode: "inline" | "alter" | "none";

  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<string>;

  /** Consistent point-in-time reads for a whole run, where the system supports it. No-ops elsewhere. */
  beginSnapshot(): Promise<boolean>;
  endSnapshot(): Promise<void>;

  describeExtras(table: string): Promise<TableExtras>;
  listObjects(): Promise<ObjectInventory[]>;
  maxValue(table: string, column: string): Promise<string | null>;
  createIndex(table: string, index: IndexInfo): Promise<void>;
  addForeignKey(table: string, fk: ForeignKeyInfo): Promise<void>;
  /** The statement addForeignKey would run, for reports when it fails. */
  foreignKeySql?(table: string, fk: ForeignKeyInfo): string;
  dropForeignKey(table: string, name: string): Promise<void>;

  insertFromTable(from: string, to: string, columns: string[]): Promise<void>;
  /** After rows with explicit keys are appended, move the auto-generated counter past them. Not every system can. */
  syncIdentity?(table: string, column: string): Promise<void>;
  countKeyCollisions(staging: string, target: string, keys: string[]): Promise<number>;
  deleteMatchingKeys(target: string, staging: string, keys: string[]): Promise<void>;

  listTables(): Promise<string[]>;
  describeTable(name: string): Promise<TableInfo>;
  countRows(table: string): Promise<number>;
  readRows(table: string, opts: ReadOptions): AsyncGenerator<Batch>;

  /** Identifier convention of the target system (lower for most, UPPER for Oracle/Snowflake). */
  normalizeIdentifier(name: string): string;
  isReservedWord(name: string): boolean;

  tableExists(name: string): Promise<boolean>;
  ddlFor(table: TableInfo, opts?: DdlOptions): string;
  createTable(table: TableInfo, opts?: DdlOptions): Promise<void>;
  insertRows(table: TableInfo, columns: string[], rows: unknown[][]): Promise<void>;
  renameTable(from: string, to: string): Promise<void>;
  dropTable(name: string): Promise<void>;
  /** Number of key values that appear more than once. Used when the target does not enforce PKs. */
  countDuplicateKeys(table: string, keys: string[]): Promise<number>;
  maxInsertRows(columnCount: number): number;
}

export type Severity = "error" | "warn" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  table?: string;
  column?: string;
  message: string;
}

export interface ColumnPlan {
  source: ColumnInfo;
  target: ColumnInfo;
}

export interface TablePlan {
  sourceTable: string;
  targetTable: string;
  columns: ColumnPlan[];
  excludedColumns: string[];
  /** Primary key as target column names. */
  primaryKey: string[];
  /** Whether the PK constraint will be created on the target. */
  createPrimaryKey: boolean;
  sourceRowCount: number;
  ddl: string;
  /** Target-side names. Created on the staging table before verification. */
  indexes: IndexInfo[];
  /** Target-side names. Added after every table is promoted. */
  foreignKeys: ForeignKeyInfo[];
  /** Single auto-generated target column. `start` is its value at plan time; the run recomputes it just before loading. */
  identity?: { column: string; start: string };
  /** append: the columns that identify a row, used to detect collisions and to undo the append. */
  appendKey?: string[];
  /** replace/append: the target table as it exists today. */
  existingTarget?: { columns: string[]; primaryKey: string[]; identity?: string };
  issues: Issue[];
}

/**
 * create: new tables only (default). replace: swap in a new table and keep the old one as a backup until finalize.
 * append: add rows to an existing table, checking for key collisions first.
 */
export type MigrationMode = "create" | "replace" | "append";

export interface Plan {
  id: string;
  createdAt: string;
  source: string;
  target: string;
  sourceKind: DbKind;
  targetKind: DbKind;
  mode: MigrationMode;
  tables: TablePlan[];
  issues: Issue[];
  /** Views, triggers, sequences and routines found in the source. Never migrated; listed so nothing is forgotten. */
  inventory: ObjectInventory[];
  /** Hash of the semantic content of the plan. Any change invalidates the dry run. */
  hash: string;
}

export interface TableOverride {
  source: string;
  target?: string;
  exclude?: string[];
  renames?: Record<string, string>;
  typeOverrides?: Record<
    string,
    { type: CanonicalType; length?: number; precision?: number; scale?: number }
  >;
  /** Set or replace the primary key (source column names). */
  primaryKey?: string[];
}

export interface FailureExample {
  row: string;
  reason: string;
  value?: string;
}

export interface FailureSummary {
  column: string;
  code: string;
  count: number;
  examples: FailureExample[];
}

export interface DryRunTableResult {
  table: string;
  rowsChecked: number;
  rowsFailed: number;
  emptyStringsToNull: number;
  failures: FailureSummary[];
}

export interface DryRunResult {
  planHash: string;
  at: string;
  ok: boolean;
  /** False when the dry run stopped early (maxRows). An incomplete dry run cannot authorise a migration. */
  complete: boolean;
  tables: DryRunTableResult[];
}

export interface PlanRecord {
  plan: Plan;
  dryRun?: DryRunResult;
}

export interface SerializedDigest {
  rows: number;
  total: string;
  cols: string[];
}

export type TableStatus =
  | "pending"
  | "staging"
  | "staged"
  | "verified"
  | "promoted"
  | "failed"
  | "rolled_back";

export interface VerifyResult {
  ok: boolean;
  sourceRows: number;
  targetRows: number;
  sourceDigest: string;
  targetDigest: string;
  mismatchedColumns: string[];
}

export interface TableRunState {
  sourceTable: string;
  targetTable: string;
  stagingTable: string;
  status: TableStatus;
  cursor?: Cursor;
  rowsRead: number;
  rowsLoaded: number;
  digest?: SerializedDigest;
  sourceCountBefore?: number;
  sourceCountAfter?: number;
  verify?: VerifyResult;
  stagingCreated: boolean;
  /** replace: where the previous table went. */
  backupTable?: string;
  /** append: rows in the target before and after promotion. */
  targetCountBefore?: number;
  indexesCreated?: string[];
  /** Value the identity column was created to continue from. */
  identityStart?: string;
  /** append: key columns used to undo this table's rows. */
  appendKey?: string[];
  error?: string;
}

export interface ConstraintFailure {
  table: string;
  name: string;
  sql: string;
  error: string;
}

export interface RunState {
  id: string;
  planId: string;
  planHash: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "partial" | "succeeded" | "failed" | "rolled_back";
  /** Why the run failed, including failures that belong to no single table (promotion, key collisions). */
  error?: string;
  mode: MigrationMode;
  tables: TableRunState[];
  warnings: string[];
  /** "consistent": every table was read from one point-in-time view. "interrupted": the run was paused and resumed, so views differ. */
  snapshot: "consistent" | "interrupted" | "none";
  /** Foreign keys this run added, so rollback can remove them first. */
  foreignKeys: { table: string; name: string }[];
  /** Constraints that could not be created. The data is verified and promoted; these need attention. */
  constraintFailures: ConstraintFailure[];
  /** After finalize, backups and append staging are gone and rollback is no longer possible. */
  finalized?: boolean;
  /** False for an append into a table without a key: rows cannot be told apart, so they cannot be removed. */
  rollbackable: boolean;
}
