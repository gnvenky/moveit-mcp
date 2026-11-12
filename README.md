# moveit-mcp

**Point your coding agent at a source and a target. It maps the schema, rehearses the move, and proves nothing was lost.**

`moveit-mcp` is an [MCP](https://modelcontextprotocol.io) server and CLI that lets agents like Claude Code, Codex and Cursor migrate tables between databases without the usual "ran a script, hope it worked" step. Every migration is dry-run first, read from one consistent view of the source where the database supports it, loaded into hidden staging tables, read back and compared against the source, and only then swapped into place. If anything fails, your existing tables were never touched.

Supported: **PostgreSQL · MySQL · Oracle · Snowflake · Databricks · SQLite · CSV**, in any direction.

```
$ moveit migrate --source csv_in --target db --yes      # real output: a 2,500-row CSV into SQLite

Plan plan_95fde23a37 (hash 03a90805522d5a02): 1 table(s)
  customers -> customers  2500 rows, 9 columns
  [warn] customers.mrr: SQLite stores numbers as 64-bit floats, so values beyond ~15 significant digits cannot be stored exactly; verification will fail if any do. Use a text type override for exact values.
  dry run customers: 2500 rows, 0 failing

Run run_1fd56ce0: succeeded
  customers: promoted, 2500 rows, verified
Report: ./.moveit/runs/run_1fd56ce0/report.md
```

## How it keeps data safe

1. **Plan** (`plan_migration`) proposes column types, names, keys, indexes, defaults, identity columns and DDL, and flags conflicts. Writes nothing.
2. **Dry run** (`dry_run`) reads *every* source row and checks it converts to the target types: integer ranges, decimal precision and scale, string lengths, `NOT NULL`, impossible dates, invalid JSON. Failures are reported per column with the row keys, not the values.
3. **Run** (`run_migration`) needs the plan's hash, proving the exact plan was reviewed, and a complete passing dry run of that same plan. It reads every table from **one point-in-time view** of the source where the system supports it (PostgreSQL, MySQL/InnoDB, Oracle; opt-in elsewhere, see [Consistency](#consistency-and-resume)), and loads each table into a staging table.
4. **Verifies** by reading the staged data back and comparing row counts, an order-independent whole-table digest and a per-column digest against what was sent. Inside a snapshot the source count and the rows read come from the same instant and must agree exactly; without one, the count is checked before and after the copy, so a source that changed mid-copy fails the run.
5. **Promotes** all tables together with metadata-only renames (or, for append, one insert per table after a key check). A failure at any earlier point leaves existing tables untouched.
6. **Rolls back** (`rollback`) on request, undoing exactly what the run did. It never touches the source.

Every step is written to a hash-chained evidence log, and `export_report` turns it into a Markdown report. The chain makes edits and deletions detectable; it is tamper-evident, not tamper-proof, so record the head hash elsewhere if that matters to you.

## Modes: create, replace, append

`plan_migration` takes a `mode`:

| Mode | What it does | Safety net |
|---|---|---|
| `create` (default) | New tables only. Refuses if a target table exists. | Nothing existing is touched. |
| `replace` | Loads and verifies a new table, then swaps it in. The old table is renamed to `_moveit_<run>_bak_<table>` and kept. | `rollback` puts the old table back. `finalize_run` drops the backups when you are satisfied (after which rollback is no longer possible). |
| `append` | Adds the source rows to a table that already exists. Rows are staged and verified first; every key is checked against the existing table before anything is written; a collision stops the run with nothing appended. | `rollback` deletes exactly the appended rows by key. The staging tables are kept for that until `finalize_run`. |

Things worth knowing:

- **Replace** refuses when a table *outside* the plan has a foreign key into a table being replaced (the constraint would silently follow the old table into the backup). Grants, views and triggers that depended on the old table are not carried over.
- **Append** checks that every planned column exists in the target and that no other `NOT NULL` column would be left unfilled. Without a key the rows cannot be told apart, so duplicates cannot be detected and the run cannot be rolled back; the plan says so. After an append, the existing table's row count is checked, and the whole table is digested when it started empty. On PostgreSQL the table's serial/identity counter is moved past the appended keys; on other systems the plan warns that you must reset it.
- Append is not offered for CSV targets.

## What is migrated besides columns

| | Carried over | Notes |
|---|---|---|
| **Primary keys** | yes | Named constraints; not enforced on Snowflake/Databricks, so duplicates are checked after staging. |
| **Identity / auto-increment** | yes, for a single integer primary key | PostgreSQL `GENERATED BY DEFAULT AS IDENTITY` (serial columns too), MySQL `AUTO_INCREMENT`, Oracle identity, Snowflake `AUTOINCREMENT`, Databricks identity (BIGINT), SQLite rowid alias. The counter continues after the highest value copied, computed at run time and checked after loading. |
| **Defaults** | plain literals, `now()` / `CURRENT_TIMESTAMP`, `CURRENT_DATE` | Anything else (sequence calls, UDFs, expressions) is reported, not guessed. Off by default on Databricks (needs a Delta table feature; set `"defaults": true`). |
| **Indexes** | yes, where the target has them | Created after the load. A failure is reported with its statement and never fails the run. Partial, expression, full-text, spatial and prefix indexes are listed as not migrated. |
| **Foreign keys** | yes, between tables in the same plan | Added after every table is promoted (SQLite: declared in `CREATE TABLE`). A failure is reported with its statement and never fails the run. Not created on Snowflake or Databricks, which do not enforce them. |
| **Views, triggers, sequences, routines** | **no** | Listed in the plan (`inventory`) and in the report so nothing is forgotten. |
| **Grants, check constraints** | no | |

Each of identity, defaults, indexes and foreign keys can be turned off with `objects` on `plan_migration` (CLI: `--skip-objects indexes,foreign-keys,defaults,identity`).

## Consistency and resume

**Snapshot reads.** One transaction (or equivalent) is held for the whole staging phase, so every table, and every count, is read as of the same instant even while the source is being written to.

| Source | How | |
|---|---|---|
| PostgreSQL | `REPEATABLE READ, READ ONLY` transaction | automatic, tested live |
| MySQL | `START TRANSACTION WITH CONSISTENT SNAPSHOT` (InnoDB) | automatic, not tested live |
| Oracle | `SET TRANSACTION READ ONLY` | automatic, not tested live; a long run needs enough undo to avoid ORA-01555 |
| SQLite | one read transaction | opt-in `"snapshot": true`; needs WAL mode or writers wait |
| Snowflake, Databricks | Time Travel `AT(TIMESTAMP => ...)` / `TIMESTAMP AS OF` | opt-in `"snapshot": true`; the table's retention must cover the run; not tested live |
| CSV | none | |

If the source changes after the snapshot, the run still succeeds and records a warning; `reconcile` later shows the drift. A run that is paused (`maxBatches`) and resumed takes a new snapshot, so the report marks it `interrupted`. A source that supports no snapshot keeps the strict rule: the row count must not change during the copy.

**Resume after a crash.** The checkpoint is written after each batch lands, so a crash between the two can leave rows in staging that the checkpoint does not know about. On resume, each staging table's row count is compared with the checkpoint. If they differ, that table is dropped and restarted from the beginning (with a warning); if they agree, loading continues where it stopped. Nothing is duplicated either way, and verification still compares everything at the end.

**Speed.** Reading the next batch from the source overlaps with writing the previous one (`prefetch`, default 2 batches; 0 turns it off). Snowflake and Databricks can also bulk load, see below.

## Quick start

```bash
git clone <this repo> && cd moveit-mcp
npm install && npm run build       # Node 22.13+
npm link                           # puts `moveit` on your PATH (or run: node dist/src/index.js ...)
moveit setup                       # writes moveit.config.json and prints MCP client settings
moveit doctor                      # checks drivers and connections
```

Keep passwords in environment variables and reference them as `"${NAME}"`. Mark sources `"readOnly": true`, ideally backed by a read-only database user.

```json
{
  "connections": {
    "legacy_pg": { "type": "postgres", "url": "${LEGACY_PG_URL}", "readOnly": true },
    "warehouse": { "type": "snowflake", "account": "myorg-acct", "username": "MOVEIT", "password": "${SNOWFLAKE_PASSWORD}",
                   "warehouse": "LOAD_WH", "database": "ANALYTICS", "schema": "RAW", "role": "LOADER" }
  }
}
```

Add it to your MCP client:

```json
{ "mcpServers": { "moveit": { "command": "moveit", "args": ["mcp"], "env": { "MOVEIT_CONFIG": "/path/to/moveit.config.json" } } } }
```

Then ask your agent: *"Migrate the orders and customers tables from legacy_pg to warehouse."*

Database drivers (`pg`, `mysql2`, `oracledb`, `snowflake-sdk`, `@databricks/sql`) are optional dependencies, loaded only when a connection of that type is used.

### Connection options beyond the basics

| Option | Systems | Effect |
|---|---|---|
| `readOnly` | all | Refuse every write through this connection. |
| `snapshot` | SQLite, Snowflake, Databricks (sources) | Read all tables as of one instant. |
| `bulkLoad: true` | Snowflake (targets) | Load each batch with `PUT` to the user stage + `COPY INTO` instead of multi-row `INSERT`. Batches default to 50,000 rows. **Not verified against a live account.** |
| `bulkLoad: { "volume": "/Volumes/cat/schema/vol" }` | Databricks (targets) | Upload each batch to a Unity Catalog volume and `INSERT ... SELECT FROM read_files(...)`. **Not verified against a live workspace.** |
| `identity: false` | Snowflake, Databricks (targets) | Copy auto-generated keys as plain values. |
| `defaults: true` | Databricks (targets) | Create column defaults (enables the `allowColumnDefaults` table feature). |
| `primaryKeys: false` | Databricks (targets) | For `hive_metastore`, which has no key constraints. |

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `list_connections` | Connection names, types, read-only flag. Never credentials. | no |
| `test_connection` | Connect and ping. | no |
| `inspect_schema` | Tables, columns, native and canonical types, keys, row counts. | no |
| `sample_rows` | A few rows, with emails, card numbers, SSNs, names and addresses redacted by default. | no |
| `profile_data` | Per-column nulls, distinct counts, lengths, min/max, candidate keys. | no |
| `plan_migration` | Mapping, DDL, identity, defaults, indexes, foreign keys and conflicts. Takes `mode` and `objects`. Returns `planId` and `planHash`. | no |
| `get_plan` | Show a plan and its dry-run status. | no |
| `dry_run` | Validate every row against the plan. | no |
| `run_migration` | Snapshot, stage, verify, promote. Supports `maxBatches`, `resumeRunId`, `prefetch`. | **yes** |
| `run_status` | Per-table progress. | no |
| `reconcile` | Re-read both sides now and compare digests. Detects drift later. (Not applicable to append plans, where the target also holds older rows.) | no |
| `rollback` | Undo a run. Requires `confirm` equal to the run id. | **yes** |
| `finalize_run` | Drop the backups (replace) or staging tables (append) a run kept. Requires `confirm`. After this, no rollback. | **yes** |
| `export_report` | Markdown report plus evidence-chain integrity check. | report file |

Overrides on `plan_migration` let an agent fix what the dry run finds: `target` (table name), `exclude`, `renames`, `typeOverrides` (to any canonical type, with length, precision and scale) and `primaryKey`.

CLI equivalents: `moveit migrate --source A --target B [--mode create|replace|append] [--skip-objects ...] --yes`, `moveit finalize <runId> --yes`, `moveit rollback <runId> --yes`.

## Support matrix: read this before pointing it at production

| System | Source | Target | How it was tested |
|---|---|---|---|
| **SQLite** | yes | yes | Automated end-to-end tests, including every feature above |
| **CSV** | yes | yes (create, replace) | Automated end-to-end tests; tested in SQLite → CSV → SQLite round trips |
| **PostgreSQL** | yes | yes | Automated tests **against a live PostgreSQL 18**: PostgreSQL → PostgreSQL, SQLite → PostgreSQL, and PostgreSQL → CSV → PostgreSQL paths; independent in-database hash comparison, identity, defaults, indexes, foreign keys, snapshots under a concurrent writer, crash-resume, replace, append, rollback, finalize |
| **MySQL** | yes | yes | Unit tests of the SQL it generates and of how it reads catalog rows (identity, defaults, indexes, foreign keys). **Never run against a live server.** |
| **Oracle** | yes | yes | Same: unit tests only. **Never run against a live server.** |
| **Snowflake** | yes | yes | Same, plus tests of the bulk-load statements against a fake driver. **Never run against a live account.** |
| **Databricks** | yes | yes | Same, plus tests of the bulk-load statements against a fake driver. **Never run against a live workspace.** |

The MySQL, Oracle, Snowflake and Databricks adapters follow each system's documented behaviour, and the staged-load-plus-verification design means a wrong guess about *data* should surface as a failed run rather than bad data. Index, foreign-key and identity DDL is different: a statement the server rejects is reported with its text instead of failing the run (identity and defaults, which are part of `CREATE TABLE`, fail the staging step instead, before anything is promoted).

**Tested migration paths are not a full source/target matrix.** The regular end-to-end suite exercises SQLite → SQLite and SQLite → CSV → SQLite. The live PostgreSQL suite also exercises PostgreSQL → PostgreSQL, SQLite → PostgreSQL, and PostgreSQL → CSV → PostgreSQL. These tests do not establish that every supported source can migrate directly to every supported target.

The optional live conformance suite, `test/conformance.live.test.ts`, runs SQLite → configured system → SQLite for each system you provide: digests are compared at every hop, schema objects are read back, and where supported it checks a snapshot read under a concurrent writer, identity and defaults on new rows, replace + finalize, and append + rollback. SQLite always runs; PostgreSQL runs when `MOVEIT_TEST_PG` is set; MySQL, Oracle, Snowflake, and Databricks run only when their corresponding `MOVEIT_TEST_*` variables are set. The README's current live-test status is listed in the table above; having a conformance test available does not mean that system has been tested against a live server/account/workspace. Give the suite a **scratch** database or schema (it only creates and drops tables named `conf_*`):

```bash
MOVEIT_TEST_MYSQL='{"type":"mysql","host":"127.0.0.1","user":"root","password":"${MYSQL_PW}","database":"scratch"}' \
MOVEIT_TEST_ORACLE='{"type":"oracle","user":"scratch","password":"${ORA_PW}","connectString":"localhost/FREEPDB1"}' \
npm run test:live
```

(`MOVEIT_TEST_SNOWFLAKE` and `MOVEIT_TEST_DATABRICKS` work the same way.) Please open an issue with anything it finds.

Notable per-system behaviour the planner already handles or warns about:

- **Oracle** cannot store `''`: it becomes `NULL`. The dry run counts these and refuses them for `NOT NULL` columns. `VARCHAR2` is limited to 4,000 bytes, so longer values map to `CLOB`. Oracle has no `TIME` or (before 23ai) `BOOLEAN`; they are stored as `VARCHAR2(15)` and `NUMBER(1,0)`. Oracle foreign keys have no `ON UPDATE`.
- **Snowflake** and **Databricks** accept `PRIMARY KEY` but do not enforce it, so duplicates are checked explicitly after staging. Databricks has no `TIME` and does not enforce `VARCHAR` length; its identity columns must be `BIGINT`.
- **SQLite** stores numbers as 64-bit floats, so decimals beyond ~15 significant digits cannot round-trip. The plan warns and verification fails safely. A lone `INTEGER PRIMARY KEY` is treated as an identity column (it is the rowid alias, which hands out the next value itself).
- **MySQL** has no timestamp-with-zone; values are normalised to UTC. Text, JSON and blob columns cannot carry a literal default or be indexed without a prefix length, so those are skipped with a note.
- Decimals wider than the target's maximum (38 on Oracle, Snowflake and Databricks) are clamped with a warning, and the dry run checks every value fits.
- A CSV has no types, so they are inferred from the first 10,000 rows (override with `typeOverrides`). Unquoted empty fields are `NULL`; quoted `""` is an empty string, and the writer preserves the difference.

## What it does not do

- **No upsert and no change-data-capture.** `append` only adds rows that do not already exist; it never updates or deletes existing ones. A snapshot is one instant, not a stream; to catch up afterwards, migrate again with `replace`.
- **Views, triggers, sequences, routines, grants, check constraints, and partial / expression / full-text indexes are not migrated.** They are listed in the plan and report.
- **Append rollback needs a key**, and append verification is a row count (plus a full digest when the table started empty), not a digest of the merged table.
- **Snapshots are per run.** A paused-and-resumed run reads different moments (marked `interrupted`). Snowflake, Databricks and SQLite snapshots are opt-in; Snowflake and Databricks use Time Travel and need retention that covers the run.
- **Bulk loading, Time Travel snapshots and the MySQL, Oracle, Snowflake and Databricks adapters as a whole have not been run against live servers** (see the support matrix and the conformance suite).
- **Identity counters on append** are only moved automatically on PostgreSQL.

## Security notes

- Credentials come from environment variables, are never returned by any tool, and are scrubbed from error messages and evidence.
- `sample_rows`, `profile_data` and dry-run examples redact sensitive-looking columns and values by default. Redaction is by column-name and value patterns, so treat it as a safety net, not a guarantee.
- Dry-run failures identify rows by primary key, which may itself be sensitive in some schemas.
- The server never writes to a connection marked `readOnly`, and it never writes to the source at all.
- `run_migration`, `rollback` and `finalize_run` are marked as writing (the last two as destructive) in MCP annotations, so clients can require human approval.
- Bulk loading writes temporary newline-delimited JSON files (mode 0600) to the OS temp directory and removes them after each batch; the same data is staged in your Snowflake user stage or Databricks volume and removed after the load.

## Development

```bash
npm install
npm test                    # unit + SQLite/CSV end-to-end + MCP protocol tests (no services needed)

# live tests: PostgreSQL (create two empty databases first) and, optionally, the conformance suite for the others
createdb moveit_src && createdb moveit_dst
MOVEIT_TEST_PG=postgres://postgres@127.0.0.1:5432 npm run test:live
```

State lives in `./.moveit` (`MOVEIT_HOME` to change): plans, run state and evidence logs. They contain connection names, never credentials.

## License

MIT
