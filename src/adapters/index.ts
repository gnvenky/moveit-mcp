import type { Adapter, ConnectionConfig, DbKind } from "../types.js";
import { CsvAdapter } from "./csv.js";
import { DatabricksAdapter } from "./databricks.js";
import { MysqlAdapter } from "./mysql.js";
import { OracleAdapter } from "./oracle.js";
import { PostgresAdapter } from "./postgres.js";
import { SnowflakeAdapter } from "./snowflake.js";
import { SqliteAdapter } from "./sqlite.js";

export const SUPPORTED: DbKind[] = ["sqlite", "postgres", "mysql", "oracle", "snowflake", "databricks", "csv"];

/** npm package each adapter needs at runtime (undefined = built in). */
export const DRIVER_PACKAGE: Record<DbKind, string | undefined> = {
  sqlite: undefined,
  csv: undefined,
  postgres: "pg",
  mysql: "mysql2",
  oracle: "oracledb",
  snowflake: "snowflake-sdk",
  databricks: "@databricks/sql",
};

export function createAdapter(cfg: ConnectionConfig): Adapter {
  switch (cfg.type) {
    case "sqlite":
      return new SqliteAdapter(cfg);
    case "postgres":
      return new PostgresAdapter(cfg);
    case "mysql":
      return new MysqlAdapter(cfg);
    case "oracle":
      return new OracleAdapter(cfg);
    case "snowflake":
      return new SnowflakeAdapter(cfg);
    case "databricks":
      return new DatabricksAdapter(cfg);
    case "csv":
      return new CsvAdapter(cfg);
    default:
      throw new Error(`Unsupported connection type "${String((cfg as any).type)}". Supported: ${SUPPORTED.join(", ")}`);
  }
}
