/**
 * @codepilot/tool-engine — M3 ToolRegistry
 *
 * Central, provider-agnostic tool registry. Deterministic lookup, duplicate
 * protection, enable/disable, validation and coordinated disposal.
 */

import type {
  ToolDefinition,
  ToolError,
  ToolSchema,
  ToolSchemaProperty,
} from "./types.js";
import { toolError } from "./types.js";

export interface RegistryEntry {
  tool: ToolDefinition;
  enabled: boolean;
  registeredAt: number;
}

export interface ToolListFilter {
  category?: ToolDefinition["category"];
  enabledOnly?: boolean;
  capability?: string;
}

/** Structural validation of input against the tool's JSON-ish schema. */
export function validateAgainstSchema(
  schema: ToolSchema,
  input: unknown,
  executionId: string,
): ToolError | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return toolError(
      "VALIDATION",
      "Tool input must be an object",
      executionId,
      {
        recoverable: false,
      },
    );
  }
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj) || obj[key] === undefined) {
      return toolError(
        "VALIDATION",
        `Missing required input: ${key}`,
        executionId,
        {
          recoverable: false,
        },
      );
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) {
        return toolError("VALIDATION", `Unknown input: ${key}`, executionId, {
          recoverable: false,
        });
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    const err = validateProperty(key, value, prop, executionId);
    if (err) return err;
  }
  return null;
}

function validateProperty(
  key: string,
  value: unknown,
  prop: ToolSchemaProperty,
  executionId: string,
): ToolError | null {
  if (value === undefined || value === null) return null;
  if (prop.type === "array") {
    if (!Array.isArray(value)) return typeMismatch(key, "array", executionId);
    if (prop.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateProperty(
          `${key}[${i}]`,
          value[i],
          prop.items,
          executionId,
        );
        if (err) return err;
      }
    }
    return null;
  }
  if (prop.type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      return typeMismatch(key, "object", executionId);
    }
    return null;
  }
  if (typeof value !== prop.type)
    return typeMismatch(key, prop.type, executionId);
  if (prop.enum && !prop.enum.includes(String(value))) {
    return toolError(
      "VALIDATION",
      `Invalid value for ${key}: must be one of ${prop.enum.join(", ")}`,
      executionId,
      { recoverable: false },
    );
  }
  return null;
}

function typeMismatch(
  key: string,
  expected: string,
  executionId: string,
): ToolError {
  return toolError(
    "VALIDATION",
    `Input ${key} must be of type ${expected}`,
    executionId,
    {
      recoverable: false,
    },
  );
}

// ============================================================================
// ToolRegistry
// ============================================================================

/**
 * Central, provider-agnostic tool registry.
 * - Duplicate registration is rejected (overwrite requires unregister first).
 * - Lookup is deterministic: exact id, O(1) map access.
 * - Disabled tools are discoverable but not executable.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private disposed = false;

  register(tool: ToolDefinition): void {
    this.assertUsable();
    if (!tool?.id || typeof tool.id !== "string") {
      throw new Error("ToolRegistry.register: tool must have a string id");
    }
    if (this.entries.has(tool.id)) {
      throw new Error(
        `ToolRegistry.register: tool '${tool.id}' is already registered — unregister() it first`,
      );
    }
    this.entries.set(tool.id, {
      tool,
      enabled: true,
      registeredAt: Date.now(),
    });
  }

  unregister(toolId: string): boolean {
    this.assertUsable();
    return this.entries.delete(toolId);
  }

  has(toolId: string): boolean {
    return this.entries.has(toolId);
  }

  /** Deterministic exact lookup. Returns null for unknown ids. */
  get(toolId: string): ToolDefinition | null {
    return this.entries.get(toolId)?.tool ?? null;
  }

  isEnabled(toolId: string): boolean {
    return this.entries.get(toolId)?.enabled ?? false;
  }

  enable(toolId: string): boolean {
    const entry = this.entries.get(toolId);
    if (!entry) return false;
    entry.enabled = true;
    return true;
  }

  disable(toolId: string): boolean {
    const entry = this.entries.get(toolId);
    if (!entry) return false;
    entry.enabled = false;
    return true;
  }

  /** List tool metadata, optionally filtered. Sorted by id for determinism. */
  list(filter?: ToolListFilter): ToolDefinition[] {
    const tools = [...this.entries.values()]
      .filter((e) => {
        if (filter?.enabledOnly && !e.enabled) return false;
        if (filter?.category && e.tool.category !== filter.category)
          return false;
        if (
          filter?.capability &&
          !e.tool.capabilities.includes(filter.capability)
        ) {
          return false;
        }
        return true;
      })
      .map((e) => e.tool);
    return tools.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Validate an input object against a registered tool's schema. */
  validateInput(
    toolId: string,
    input: unknown,
    executionId: string,
    cwd?: string,
  ): ToolError | null {
    const tool = this.get(toolId);
    if (!tool) {
      return toolError("NOT_FOUND", `Unknown tool: ${toolId}`, executionId, {
        recoverable: false,
      });
    }
    if (!this.isEnabled(toolId)) {
      return toolError(
        "UNSUPPORTED",
        `Tool '${toolId}' is disabled`,
        executionId,
      );
    }
    const schemaErr = validateAgainstSchema(
      tool.inputSchema,
      input,
      executionId,
    );
    if (schemaErr) return schemaErr;
    // Semantic validation provided by the tool itself.
    if (tool.validate) {
      return tool.validate(
        input as Record<string, unknown>,
        cwd ?? process.cwd(),
      );
    }
    return null;
  }

  /** Dispose all tools that expose dispose() and clear the registry. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    const errors: unknown[] = [];
    for (const entry of this.entries.values()) {
      try {
        await entry.tool.dispose?.();
      } catch (err) {
        errors.push(err);
      }
    }
    this.entries.clear();
    this.disposed = true;
    if (errors.length > 0) {
      throw new Error(
        `ToolRegistry.dispose: ${errors.length} tool(s) failed to dispose: ${errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join("; ")}`,
      );
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("ToolRegistry has been disposed");
    }
  }
}
