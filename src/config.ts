import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdapter } from "./adapters/index.js";
import type { Adapter, ConnectionConfig } from "./types.js";

export interface MoveitConfig {
  connections: Record<string, ConnectionConfig>;
  /** Directory for plans, runs and evidence. Default ./.moveit */
  home?: string;
}

const SECRET_KEYS = /pass|secret|token|key|pwd|url|connectstring|wallet/i;

/** Replace ${ENV_VAR} references. A missing variable is an error that names the variable, never a value. */
function substitute(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`Environment variable ${name} (needed by ${path}) is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => substitute(v, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, `${path}.${k}`)]));
  return value;
}

export function findConfigPath(explicit?: string): string {
  return resolve(explicit ?? process.env.MOVEIT_CONFIG ?? "moveit.config.json");
}

export function loadConfig(explicit?: string): { config: MoveitConfig; path: string } {
  const path = findConfigPath(explicit);
  if (!existsSync(path))
    throw new Error(`No config found at ${path}. Run "moveit setup" or set MOVEIT_CONFIG.`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.connections || typeof raw.connections !== "object")
    throw new Error(`${path} must contain a "connections" object.`);
  return { config: raw as MoveitConfig, path };
}

export function moveitHome(config?: MoveitConfig): string {
  return resolve(process.env.MOVEIT_HOME ?? config?.home ?? ".moveit");
}

/** Connection names and types only. Never returns credentials. */
export function describeConnections(config: MoveitConfig): { name: string; type: string; readOnly: boolean }[] {
  return Object.entries(config.connections).map(([name, c]) => ({
    name,
    type: c.type,
    readOnly: c.readOnly === true,
  }));
}

/** Strip anything secret-looking from an error message before it reaches the agent or the evidence log. */
export function scrub(text: string, config?: MoveitConfig): string {
  let out = text;
  if (config) {
    for (const c of Object.values(config.connections)) {
      for (const [k, v] of Object.entries(c)) {
        if (typeof v !== "string" || v.length < 4) continue;
        const resolved = (() => {
          try {
            return substitute(v, k) as string;
          } catch {
            return undefined;
          }
        })();
        if (resolved && SECRET_KEYS.test(k)) out = out.split(resolved).join("[redacted]");
      }
    }
  }
  return out.replace(/(password|pwd|token|secret)=([^&\s;]+)/gi, "$1=[redacted]").replace(/\/\/([^:/@\s]+):([^@\s]+)@/g, "//$1:[redacted]@");
}

/** Opens each named connection once and closes them all at exit. */
export class Connections {
  private open = new Map<string, Adapter>();
  constructor(readonly config: MoveitConfig) {}

  has(name: string): boolean {
    return name in this.config.connections;
  }

  async get(name: string): Promise<Adapter> {
    const cached = this.open.get(name);
    if (cached) return cached;
    const raw = this.config.connections[name];
    if (!raw) {
      throw new Error(
        `Unknown connection "${name}". Available: ${Object.keys(this.config.connections).join(", ") || "(none)"}`,
      );
    }
    const adapter = createAdapter(substitute(raw, `connections.${name}`) as ConnectionConfig);
    try {
      await adapter.connect();
    } catch (e: any) {
      throw new Error(`Could not connect to "${name}": ${scrub(String(e?.message ?? e), this.config)}`);
    }
    this.open.set(name, adapter);
    return adapter;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.open.values()].map((a) => a.close()));
    this.open.clear();
  }
}
