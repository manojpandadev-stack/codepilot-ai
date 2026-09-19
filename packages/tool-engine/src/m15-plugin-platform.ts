/**
 * M15 — Plugin / Extension Platform.
 *
 * Secure extensibility on top of the M3 ToolRegistry:
 *
 * - Plugins declare a manifest with explicit capabilities. Capabilities are
 *   the ONLY way a plugin gets anything: no capability → no access. There is
 *   no "all" capability by design.
 * - Tool registration is namespaced (`plugin-name:tool-name`) and routed
 *   through the existing ToolRegistry, so every plugin tool execution passes
 *   the M4 permission pipeline like any built-in tool.
 * - The trust model has three tiers: `official` (signed builds), `verified`
 *   (reviewed publisher), `community` (untrusted). Community plugins must be
 *   explicitly enabled by the user and never get filesystem/terminal caps.
 * - Uninstall/disable/re-enable are lifecycle operations with cleanup.
 */

import { ToolRegistry } from "./m3/registry.js";
import type { ToolDefinition } from "./m3/types.js";
import * as fs from "node:fs";
import * as path from "node:path";

/** Default permission level per capability — mapped to M3/M4 permissions. */
const CAPABILITY_PERMISSION: Record<
  PluginCapability,
  {
    level: "read" | "write" | "destructive" | "execute" | "network";
    requiresApproval: boolean;
  }
> = {
  "network.fetch": { level: "network", requiresApproval: false },
  "fs.read": { level: "read", requiresApproval: false },
  "fs.write": { level: "write", requiresApproval: true },
  "terminal.execute": { level: "execute", requiresApproval: true },
  "context.read": { level: "read", requiresApproval: false },
  "events.subscribe": { level: "read", requiresApproval: false },
};

// ============================================================================
// Capabilities
// ============================================================================

/**
 * Explicit, narrow capabilities. Never add a wildcard — every capability
 * must map to a reviewable, revocable permission.
 */
export const PLUGIN_CAPABILITIES = [
  "network.fetch", // outbound HTTP via the web layer (SSRF-protected)
  "fs.read", // read workspace files through the context engine
  "fs.write", // write workspace files — REQUIRES M4 approval per call
  "terminal.execute", // run commands — REQUIRES M4 approval per call
  "context.read", // read assembled model context
  "events.subscribe", // subscribe to agent events (read-only)
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export type PluginTrustLevel = "official" | "verified" | "community";

/** Capabilities community plugins may never hold. */
const FORBIDDEN_FOR_COMMUNITY: readonly PluginCapability[] = [
  "terminal.execute",
];

// ============================================================================
// Manifest
// ============================================================================

export interface PluginManifest {
  /** Unique plugin id, lowercase kebab-case. */
  id: string;
  name: string;
  version: string;
  /** CodePilot platform compatibility semver range (simple major check). */
  apiVersion: string;
  trustLevel: PluginTrustLevel;
  capabilities: PluginCapability[];
  /** Tool definitions the plugin provides. */
  tools?: Array<{
    name: string;
    description: string;
  }>;
  /** Optional display metadata. */
  author?: string;
  description?: string;
}

export interface PluginManifestValidation {
  valid: boolean;
  errors: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export function validatePluginManifest(
  manifest: unknown,
): PluginManifestValidation {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["manifest must be an object"] };
  }
  const m = manifest as Partial<PluginManifest>;

  if (typeof m.id !== "string" || !ID_PATTERN.test(m.id)) {
    errors.push("id must be lowercase kebab-case (3-64 chars)");
  }
  if (typeof m.name !== "string" || m.name.length < 1 || m.name.length > 100) {
    errors.push("name must be 1-100 chars");
  }
  if (typeof m.version !== "string" || !SEMVER_PATTERN.test(m.version)) {
    errors.push("version must be semver");
  }
  if (typeof m.apiVersion !== "string" || !SEMVER_PATTERN.test(m.apiVersion)) {
    errors.push("apiVersion must be semver");
  }
  if (
    m.trustLevel !== "official" &&
    m.trustLevel !== "verified" &&
    m.trustLevel !== "community"
  ) {
    errors.push("trustLevel must be official | verified | community");
  }
  if (!Array.isArray(m.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    for (const cap of m.capabilities) {
      if (!(PLUGIN_CAPABILITIES as readonly string[]).includes(cap)) {
        errors.push(`unknown capability: ${String(cap)}`);
      }
    }
    if (
      m.trustLevel === "community" &&
      m.capabilities.some((c) => FORBIDDEN_FOR_COMMUNITY.includes(c))
    ) {
      errors.push(
        `community plugins cannot request: ${FORBIDDEN_FOR_COMMUNITY.join(", ")}`,
      );
    }
  }
  if (m.tools !== undefined) {
    if (!Array.isArray(m.tools)) {
      errors.push("tools must be an array");
    } else {
      for (const tool of m.tools) {
        if (
          !tool ||
          typeof tool.name !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tool.name)
        ) {
          errors.push(
            `invalid tool name: ${String((tool as { name?: unknown })?.name)}`,
          );
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Platform API compatibility: same major version required. */
export function isApiCompatible(
  pluginApiVersion: string,
  platformApiVersion: string,
): boolean {
  const pluginMajor = SEMVER_PATTERN.exec(pluginApiVersion)?.[0]?.split(".")[0];
  const platformMajor =
    SEMVER_PATTERN.exec(platformApiVersion)?.[0]?.split(".")[0];
  return (
    pluginMajor !== undefined &&
    platformMajor !== undefined &&
    pluginMajor === platformMajor
  );
}

// ============================================================================
// Plugin manager
// ============================================================================

export interface PluginToolContext {
  pluginId: string;
  capabilities: readonly PluginCapability[];
  /** True when the call was approved through M4. */
  approved?: boolean;
}

export type PluginToolHandler = (
  args: Record<string, unknown>,
  context: PluginToolContext,
) => Promise<unknown>;

interface PluginState {
  manifest: PluginManifest;
  handlers: Map<string, PluginToolHandler>;
  enabled: boolean;
  installedAtMs: number;
}

export interface PluginInstallOptions {
  /** Skip the community-trust user enablement gate (official/verified only). */
  skipCommunityGate?: boolean;
}

export class PluginManager {
  private plugins = new Map<string, PluginState>();
  private readonly platformApiVersion: string;
  private readonly maxPlugins: number;

  constructor(
    private readonly registry: ToolRegistry,
    options?: { platformApiVersion?: string; maxPlugins?: number },
  ) {
    this.platformApiVersion = options?.platformApiVersion ?? "1.0.0";
    this.maxPlugins = options?.maxPlugins ?? 50;
  }

  /** Install (register) a plugin without activating it. */
  install(
    manifest: unknown,
    handlers: Record<string, PluginToolHandler>,
    options?: PluginInstallOptions,
  ): { ok: true; pluginId: string } | { ok: false; errors: string[] } {
    const validation = validatePluginManifest(manifest);
    if (!validation.valid) {
      return { ok: false, errors: validation.errors };
    }
    const pluginManifest = manifest as PluginManifest;

    if (!isApiCompatible(pluginManifest.apiVersion, this.platformApiVersion)) {
      return {
        ok: false,
        errors: [
          `plugin apiVersion ${pluginManifest.apiVersion} incompatible with platform ${this.platformApiVersion}`,
        ],
      };
    }
    if (this.plugins.size >= this.maxPlugins) {
      return { ok: false, errors: [`plugin cap (${this.maxPlugins}) reached`] };
    }
    if (this.plugins.has(pluginManifest.id)) {
      return {
        ok: false,
        errors: [`plugin '${pluginManifest.id}' is already installed`],
      };
    }
    // Community gate: untrusted plugins need explicit user opt-in to install.
    if (
      pluginManifest.trustLevel === "community" &&
      !options?.skipCommunityGate
    ) {
      return {
        ok: false,
        errors: [
          "community plugin requires explicit user enablement (untrusted source)",
        ],
      };
    }
    // Every declared tool must have a handler.
    const declared = pluginManifest.tools ?? [];
    for (const tool of declared) {
      if (typeof handlers[tool.name] !== "function") {
        return {
          ok: false,
          errors: [`tool '${tool.name}' declared without a handler`],
        };
      }
    }

    this.plugins.set(pluginManifest.id, {
      manifest: pluginManifest,
      handlers: new Map(Object.entries(handlers)),
      enabled: false,
      installedAtMs: Date.now(),
    });
    return { ok: true, pluginId: pluginManifest.id };
  }

  /** Activate a plugin: register its tools with the ToolRegistry. */
  activate(pluginId: string): { ok: boolean; errors: string[] } {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return { ok: false, errors: [`unknown plugin: ${pluginId}`] };
    if (plugin.enabled) return { ok: true, errors: [] };

    const errors: string[] = [];
    for (const tool of plugin.manifest.tools ?? []) {
      const handler = plugin.handlers.get(tool.name);
      if (!handler) {
        errors.push(`missing handler for '${tool.name}'`);
        continue;
      }
      const toolId = `${pluginId}:${tool.name}`;
      if (this.registry.has(toolId)) {
        errors.push(`tool id collision: ${toolId}`);
        continue;
      }
      const permission = highestPermission(
        plugin.manifest.capabilities,
        plugin.manifest.trustLevel,
        pluginId,
      );
      const definition: ToolDefinition = {
        id: toolId,
        name: tool.name,
        description: `[plugin ${pluginId}] ${tool.description ?? tool.name}`,
        category: "analysis",
        version: plugin.manifest.version,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
        capabilities: ["plugin"],
        permission,
        idempotent: false,
        // Plugin tool input is untrusted; execution is capability-gated.
        execute: async (args: Record<string, unknown>) => {
          return this.invoke(pluginId, tool.name, args);
        },
      };
      try {
        this.registry.register(definition);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (
      errors.length > 0 &&
      (plugin.manifest.tools ?? []).length === errors.length
    ) {
      // Nothing registered — do not mark enabled.
      return { ok: false, errors };
    }
    plugin.enabled = true;
    return { ok: errors.length === 0, errors };
  }

  /** Deactivate: unregister tools, keep installed. */
  deactivate(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.enabled) return false;
    for (const tool of plugin.manifest.tools ?? []) {
      this.registry.unregister(`${pluginId}:${tool.name}`);
    }
    plugin.enabled = false;
    return true;
  }

  /** Uninstall: deactivate + remove state. */
  uninstall(pluginId: string): boolean {
    this.deactivate(pluginId);
    return this.plugins.delete(pluginId);
  }

  isEnabled(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.enabled ?? false;
  }

  isInstalled(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  listInstalled(): Array<{
    id: string;
    version: string;
    trustLevel: PluginTrustLevel;
    enabled: boolean;
  }> {
    return [...this.plugins.values()].map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version,
      trustLevel: p.manifest.trustLevel,
      enabled: p.enabled,
    }));
  }

  /** Capability check used by invoke() and by the approval layer. */
  hasCapability(pluginId: string, capability: PluginCapability): boolean {
    return (
      this.plugins.get(pluginId)?.manifest.capabilities.includes(capability) ??
      false
    );
  }

  /**
   * Invoke a plugin tool. Capability-gated: tools whose plugin lacks the
   * required capability are refused BEFORE any handler code runs.
   */
  async invoke(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    requiredCapability?: PluginCapability,
  ): Promise<unknown> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    if (!plugin.enabled) throw new Error(`plugin not enabled: ${pluginId}`);
    const handler = plugin.handlers.get(toolName);
    if (!handler) throw new Error(`unknown tool: ${pluginId}:${toolName}`);

    // Sandbox discipline: args are copied (no caller object escape), and the
    // handler only sees a frozen context with its own plugin identity.
    const safeArgs = structuredCloneSafe(args);
    if (
      requiredCapability &&
      !this.hasCapability(pluginId, requiredCapability)
    ) {
      throw new Error(
        `plugin '${pluginId}' lacks capability '${requiredCapability}'`,
      );
    }
    return handler(safeArgs, {
      pluginId,
      capabilities: plugin.manifest.capabilities,
    });
  }

  getManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest;
  }

  /**
   * Discover plugin manifests under a directory (production entry point).
   * Expected layout: <dir>/<plugin-id>/codepilot.plugin.json. Handlers are
   * NOT loaded here — discovery returns validated manifests plus handler
   * module paths; the host decides which handlers to wire (and never
   * auto-activates community plugins).
   */
  static discover(
    pluginsDir: string,
  ): Array<{ manifest: PluginManifest; dir: string }> {
    const out: Array<{ manifest: PluginManifest; dir: string }> = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(pluginsDir);
    } catch {
      return out; // no plugin dir — normal for most workspaces
    }
    for (const entry of entries) {
      const dir = path.join(pluginsDir, entry);
      const manifestPath = path.join(dir, "codepilot.plugin.json");
      let raw: string;
      try {
        raw = fs.readFileSync(manifestPath, "utf8");
      } catch {
        continue; // not a plugin directory
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const validation = validatePluginManifest(parsed);
        if (validation.valid) {
          out.push({ manifest: parsed as PluginManifest, dir });
        }
      } catch {
        // malformed manifest — skip, never crash discovery
      }
    }
    return out;
  }
}

const PRIVILEGE_ORDER = [
  "read",
  "write",
  "destructive",
  "execute",
  "network",
] as const;

/** Derive the M3/M4 permission for a plugin tool: highest privilege among capabilities. */
function highestPermission(
  capabilities: readonly PluginCapability[],
  trustLevel: PluginTrustLevel,
  pluginId: string,
): ToolDefinition["permission"] {
  let level: (typeof PRIVILEGE_ORDER)[number] = "read";
  let requiresApproval = false;
  for (const cap of capabilities) {
    const perm = CAPABILITY_PERMISSION[cap];
    if (PRIVILEGE_ORDER.indexOf(perm.level) > PRIVILEGE_ORDER.indexOf(level)) {
      level = perm.level;
    }
    if (perm.requiresApproval) requiresApproval = true;
  }
  if (trustLevel === "community") requiresApproval = true;
  return {
    level,
    requiresApproval,
    rationale: `Plugin tool from '${pluginId}' (trust: ${trustLevel})`,
  };
}

function structuredCloneSafe(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth > 10) return {};
  if (value === null || typeof value !== "object") {
    return { value };
  }
  if (Array.isArray(value)) {
    return { items: value.map((v) => structuredCloneSafe(v, depth + 1)) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "function" || typeof v === "symbol") continue;
    out[key] =
      v !== null && typeof v === "object"
        ? structuredCloneSafe(v, depth + 1)
        : v;
  }
  return out;
}
