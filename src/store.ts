import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanRecord, RunState } from "./types.js";

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const safeId = (id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
};

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  renameSync(tmp, file);
}

/** File-backed state. Plans and run state contain no credentials, only connection names. */
export class Store {
  constructor(readonly home: string) {
    mkdirSync(join(home, "plans"), { recursive: true });
    mkdirSync(join(home, "runs"), { recursive: true });
  }
  planFile(id: string): string {
    return join(this.home, "plans", `${safeId(id)}.json`);
  }
  runDir(id: string): string {
    return join(this.home, "runs", safeId(id));
  }
  evidenceFile(runId: string): string {
    return join(this.runDir(runId), "evidence.jsonl");
  }
  planEvidenceFile(planId: string): string {
    return join(this.home, "plans", `${safeId(planId)}.evidence.jsonl`);
  }
  savePlan(rec: PlanRecord): void {
    writeAtomic(this.planFile(rec.plan.id), rec);
  }
  loadPlan(id: string): PlanRecord {
    const f = this.planFile(id);
    if (!existsSync(f)) throw new Error(`Unknown plan "${id}"`);
    return JSON.parse(readFileSync(f, "utf8"));
  }
  saveRun(run: RunState): void {
    mkdirSync(this.runDir(run.id), { recursive: true });
    run.updatedAt = new Date().toISOString();
    writeAtomic(join(this.runDir(run.id), "state.json"), run);
  }
  loadRun(id: string): RunState {
    const f = join(this.runDir(id), "state.json");
    if (!existsSync(f)) throw new Error(`Unknown run "${id}"`);
    return JSON.parse(readFileSync(f, "utf8"));
  }
  listRuns(): string[] {
    return existsSync(join(this.home, "runs")) ? readdirSync(join(this.home, "runs")) : [];
  }
}
