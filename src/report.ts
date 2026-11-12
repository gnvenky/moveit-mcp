import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvidence, verifyEvidence } from "./evidence.js";
import type { Store } from "./store.js";

export function buildReport(store: Store, runId: string): { markdown: string; path: string; evidenceOk: boolean } {
  const run = store.loadRun(runId);
  const { plan, dryRun } = store.loadPlan(run.planId);
  const evFile = store.evidenceFile(runId);
  const chain = verifyEvidence(evFile);
  const events = readEvidence(evFile);
  const L: string[] = [];
  const total = run.tables.reduce((n, t) => n + t.rowsLoaded, 0);

  L.push(`# Migration report: ${run.id}`, "");
  L.push(`- **Status:** ${run.status}${run.finalized ? " (finalized)" : ""}`);
  L.push(`- **Mode:** ${run.mode}${run.mode === "replace" ? " (old tables kept as backups until finalized)" : run.mode === "append" ? " (rows added to existing tables)" : ""}`);
  L.push(
    `- **Source read:** ${run.snapshot === "consistent" ? "one point-in-time snapshot for every table" : run.snapshot === "interrupted" ? "snapshots, but the run was paused and resumed, so tables may be from different moments" : "no snapshot (the source supports none, or it was not enabled); row counts were checked before and after the copy"}`,
  );
  L.push(`- **Plan:** \`${plan.id}\` (hash \`${plan.hash}\`)`);
  L.push(`- **From:** ${plan.source} (${plan.sourceKind})  **To:** ${plan.target} (${plan.targetKind})`);
  L.push(`- **Started:** ${run.startedAt}  **Updated:** ${run.updatedAt}`);
  L.push(`- **Rows loaded:** ${total.toLocaleString("en-US")} across ${run.tables.length} table(s)`, "");

  L.push("## Tables", "", "| Source | Target | Rows | Status | Verified | Digest |", "|---|---|---:|---|---|---|");
  for (const t of run.tables) {
    const v = t.verify;
    L.push(
      `| ${t.sourceTable} | ${t.targetTable} | ${t.rowsLoaded.toLocaleString("en-US")} | ${t.status} | ${v ? (v.ok ? "yes" : "NO") : "-"} | ${v ? "`" + v.targetDigest + "`" : "-"} |`,
    );
  }
  L.push("");
  const objs = plan.tables.filter((t) => t.indexes.length || t.foreignKeys.length || t.identity);
  if (objs.length) {
    L.push("## Indexes, keys and identity", "");
    for (const t of objs) {
      const bad = new Set(run.constraintFailures.filter((c) => c.table === t.targetTable).map((c) => c.name));
      for (const i of t.indexes) L.push(`- ${t.targetTable}: ${i.unique ? "unique " : ""}index \`${i.name}\` (${i.columns.join(", ")}) ${bad.has(i.name) ? "**FAILED**" : "created"}`);
      for (const f of t.foreignKeys) L.push(`- ${t.targetTable}: foreign key \`${f.name}\` -> ${f.refTable} ${bad.has(f.name) ? "**FAILED**" : run.status === "succeeded" ? "created" : "pending"}`);
      if (t.identity) L.push(`- ${t.targetTable}: \`${t.identity.column}\` auto-generated, continuing from ${run.tables.find((r) => r.targetTable === t.targetTable)?.identityStart ?? t.identity.start}`);
    }
    L.push("");
  }
  if (run.constraintFailures.length) {
    L.push("## Constraints to create by hand", "", "The data is verified and in place. These could not be created:", "");
    for (const c of run.constraintFailures) L.push(`- \`${c.name}\` on ${c.table}: ${c.error}`, "  ```sql", `  ${c.sql}`, "  ```");
    L.push("");
  }
  if (plan.inventory.length) {
    L.push("## Not migrated", "", "These objects exist in the source and were not migrated:", "");
    for (const o of plan.inventory) L.push(`- ${o.kind} \`${o.name}\`${o.table ? ` (on ${o.table})` : ""}`);
    L.push("");
  }
  const failed = run.tables.filter((t) => t.error);
  if (failed.length || run.error) {
    L.push("## Errors", "");
    if (run.error && !failed.some((t) => t.error === run.error)) L.push(`- ${run.error}`);
    for (const t of failed) L.push(`- **${t.sourceTable}:** ${t.error}`);
    L.push("");
  }
  const notable = plan.issues.filter((i) => i.severity !== "info");
  if (notable.length || run.warnings.length) {
    L.push("## Warnings", "");
    for (const w of run.warnings) L.push(`- ${w}`);
    for (const i of notable) L.push(`- [${i.severity}] ${i.table ?? ""}${i.column ? "." + i.column : ""}: ${i.message}`);
    L.push("");
  }
  const e2n = dryRun?.tables.filter((t) => t.emptyStringsToNull > 0) ?? [];
  if (e2n.length) {
    L.push("## Data changes", "");
    for (const t of e2n) L.push(`- ${t.table}: ${t.emptyStringsToNull} empty string(s) became NULL (target cannot store empty strings).`);
    L.push("");
  }
  L.push(
    "## How verification works",
    "",
    "Every source value was coerced to the target column's canonical form. The loaded rows were then read back from the target and hashed the same way. Row counts, an order-independent whole-table digest, and a per-column digest must all match before any table is promoted. Without a snapshot, the source row count was also checked before and after the copy; with one, the count and the read come from the same instant. For append, staged rows are verified before anything is added to the existing table; afterwards the row count is checked, and the whole table is digested when it started empty.",
    "",
    "## Evidence log",
    "",
    `- **File:** \`${evFile}\``,
    `- **Entries:** ${chain.entries}`,
    `- **Chain intact:** ${chain.ok ? "yes" : `NO (broken at entry ${chain.brokenAt})`}`,
    `- **Head hash:** \`${chain.head}\``,
    "",
    "The log is hash-chained, so edits or deletions are detectable. Record the head hash elsewhere if you need proof against someone who can rewrite the whole file.",
    "",
    "### Timeline",
    "",
  );
  for (const e of events) L.push(`- ${e.ts} \`${e.type}\``);
  const markdown = L.join("\n") + "\n";
  const path = join(store.runDir(runId), "report.md");
  writeFileSync(path, markdown);
  return { markdown, path, evidenceOk: chain.ok };
}
