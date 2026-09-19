/**
 * @codepilot/mcp-manager — M8 configuration persistence
 *
 * Durable MCP server configuration with a security rule: environment values
 * (which frequently hold credentials) are NEVER persisted in plaintext. On
 * save, env values are replaced with a placeholder; on load, placeholders are
 * restored as empty strings so the operator can re-enter secrets.
 *
 * Writes are atomic (tmp file + rename) and loads are tolerant of missing or
 * corrupt files so a bad config can never brick the platform.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MCPServerConfig } from "./index.js";

/** Placeholder persisted in place of a secret env value. */
export const REDACTED_ENV_PLACEHOLDER = "[REDACTED]";

/** Strip env values for persistence (keys are kept, values redacted). */
export function redactEnvForPersistence(
  env?: Record<string, string>,
): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    out[key] = REDACTED_ENV_PLACEHOLDER;
  }
  return out;
}

/** Restore persisted env (placeholders become empty strings for re-entry). */
export function restoreEnvFromPersistence(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    out[key] =
      value === undefined || value === REDACTED_ENV_PLACEHOLDER ? "" : value;
  }
  return out;
}

export class MCPConfigStore {
  constructor(private readonly filePath: string) {}

  /** Persist server configs atomically. Never writes env values. */
  async save(servers: readonly MCPServerConfig[]): Promise<void> {
    const payload = servers.map((server) => ({
      ...server,
      env: redactEnvForPersistence(server.env),
    }));
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  /** Load persisted configs. Returns [] for missing or corrupt files. */
  async load(): Promise<MCPServerConfig[]> {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const servers: MCPServerConfig[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Partial<MCPServerConfig>;
        if (
          typeof candidate.name !== "string" ||
          typeof candidate.transport !== "string"
        ) {
          continue;
        }
        servers.push({
          name: candidate.name,
          transport: candidate.transport as MCPServerConfig["transport"],
          command:
            typeof candidate.command === "string"
              ? candidate.command
              : undefined,
          args: Array.isArray(candidate.args)
            ? candidate.args.filter((a): a is string => typeof a === "string")
            : undefined,
          env: restoreEnvFromPersistence(candidate.env),
          url: typeof candidate.url === "string" ? candidate.url : undefined,
          enabled: candidate.enabled ?? false,
          timeout:
            typeof candidate.timeout === "number"
              ? candidate.timeout
              : undefined,
        });
      }
      return servers;
    } catch {
      return [];
    }
  }
}
