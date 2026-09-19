/**
 * M15 — PluginService: extension-host backend for the Plugin Management UI.
 *
 * The SINGLE source of truth for plugin state. The WebView never holds
 * authoritative state: every list/install/enable/disable/uninstall/details/
 * invoke request flows WebView → extension handler → here → PluginManager →
 * (trust/capability validation) → ToolRegistry → ToolExecutionService → M4.
 *
 * Security properties (never weaken):
 * - Community (untrusted) plugins require EXPLICIT user confirmation for
 *   install AND enable. The UI cannot override this: the flag is validated
 *   here, in the backend, on every call.
 * - Tool handlers are NEVER loaded from disk. Install succeeds only when the
 *   backend PluginManager accepts (manifest, handlers) — tool-bearing
 *   manifests discovered on disk carry no handlers, so the backend refuses
 *   with an actionable error instead of inventing fake state.
 * - Execution ALWAYS goes through ToolExecutionService with the M4 pipeline.
 *   Without M4 the service fails closed ("backend unavailable").
 * - Views are sanitized (bounded strings, no handler source, no secrets —
 *   manifests contain none and none are ever added).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ToolRegistry } from "@codepilot/tool-engine";
import {
  PluginManager,
  validatePluginManifest,
  isApiCompatible,
  PLUGIN_CAPABILITIES,
  type PluginCapability,
  type PluginManifest,
  type PluginTrustLevel,
} from "@codepilot/tool-engine";
import { ToolPermissionManager } from "@codepilot/tool-engine";
import { ToolAuditLogger } from "@codepilot/tool-engine";
import { ToolExecutionService } from "@codepilot/tool-engine";
import type { M4PermissionPipeline } from "@codepilot/tool-engine";

// ============================================================================
// View types (wire format — mirrors the WebView contract)
// ============================================================================

/** UI trust badge. `untrusted` = community not yet confirmed; `blocked` = refused. */
export type PluginDisplayTrust =
  | "trusted"
  | "verified"
  | "community"
  | "untrusted"
  | "blocked";

export interface PluginToolView {
  name: string;
  description: string;
  /** Namespaced registry id (`plugin:tool`). */
  registryId: string;
  /** Actually present in the ToolRegistry right now. */
  registered: boolean;
  /** M3 permission level derived from the plugin capabilities. */
  permissionLevel: string;
  requiresApproval: boolean;
}

export interface PluginCapabilityView {
  capability: string;
  permissionLevel: string;
  requiresApproval: boolean;
  /** True when this capability is unusually broad for the trust tier. */
  sensitive: boolean;
}

export interface PluginView {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  apiVersion: string;
  trustLevel: PluginTrustLevel;
  displayTrust: PluginDisplayTrust;
  /** Manifest valid + API compatible. */
  verified: boolean;
  installed: boolean;
  enabled: boolean;
  /** On-disk manifest found during the last scan. */
  discovered: boolean;
  capabilities: PluginCapabilityView[];
  tools: PluginToolView[];
  warnings: string[];
  errors: string[];
  installedAtMs?: number;
}

export interface PluginManifestProblem {
  dir: string;
  error: string;
}

export interface PluginScanResult {
  plugins: PluginView[];
  malformed: PluginManifestProblem[];
  pluginsDir: string;
  backendAvailable: boolean;
}

export interface PluginPersistedState {
  installed: Array<{ id: string; communityConfirmed: boolean; enabled: boolean }>;
}

export interface PluginStorage {
  load(): PluginPersistedState | null;
  save(state: PluginPersistedState): void;
}

export interface PluginServiceOptions {
  platformApiVersion?: string;
  maxPlugins?: number;
  storage?: PluginStorage;
}

// ============================================================================
// Helpers
// ============================================================================

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Strict plugin-id validation for every inbound WebView payload. */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function clean(value: unknown, max = 300): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max);
}

/** Permission preview per capability (mirrors M15 CAPABILITY_PERMISSION). */
const CAPABILITY_INFO: Record<string, { level: string; approval: boolean; sensitive: boolean }> = {
  "network.fetch": { level: "network", approval: false, sensitive: true },
  "fs.read": { level: "read", approval: false, sensitive: false },
  "fs.write": { level: "write", approval: true, sensitive: true },
  "terminal.execute": { level: "execute", approval: true, sensitive: true },
  "context.read": { level: "read", approval: false, sensitive: false },
  "events.subscribe": { level: "read", approval: false, sensitive: false },
};

// ============================================================================
// PluginService
// ============================================================================

export class PluginService {
  private readonly registry = new ToolRegistry();
  private readonly manager: PluginManager;
  private readonly permissions = new ToolPermissionManager();
  private readonly audit = new ToolAuditLogger();
  private readonly execService: ToolExecutionService;
  private m4: M4PermissionPipeline | null = null;
  private readonly storage: PluginStorage | null;
  private readonly platformApiVersion: string;
  private intents = new Map<string, { communityConfirmed: boolean; enabled: boolean }>();
  /** Manifests seen by the last scan (id → manifest). */
  private discoveredCache = new Map<string, PluginManifest>();
  private disposed = false;

  constructor(options?: PluginServiceOptions) {
    this.platformApiVersion = options?.platformApiVersion ?? "1.0.0";
    this.manager = new PluginManager(this.registry, {
      platformApiVersion: this.platformApiVersion,
      maxPlugins: options?.maxPlugins ?? 50,
    });
    this.execService = new ToolExecutionService(
      this.registry,
      this.permissions,
      this.audit,
      { defaultTimeoutMs: 60_000 },
    );
    this.storage = options?.storage ?? null;
    try {
      const restored = this.storage?.load() ?? null;
      if (restored) {
        for (const entry of restored.installed) {
          if (isValidPluginId(entry.id)) {
            this.intents.set(entry.id, {
              communityConfirmed: entry.communityConfirmed === true,
              enabled: entry.enabled === true,
            });
          }
        }
      }
    } catch {
      // corrupt persisted state — start clean, never crash activation
    }
  }

  /** Attach (or replace) the M4 pipeline. Execution without M4 fails closed. */
  setM4Pipeline(pipeline: M4PermissionPipeline | null): void {
    this.m4 = pipeline;
  }

  get pluginManager(): PluginManager {
    return this.manager;
  }

  get toolRegistry(): ToolRegistry {
    return this.registry;
  }

  // ---- Scan ---------------------------------------------------------------

  /**
   * Reconcile disk + persisted intent + manager state and return the full
   * view. Never throws: per-plugin failures become errors[]/malformed[].
   */
  scan(pluginsDir: string): PluginScanResult {
    const discovered = new Map<string, { manifest: PluginManifest; dir: string }>();
    const malformed: PluginManifestProblem[] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pluginsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const dir = path.join(pluginsDir, entry);
      const manifestPath = path.join(dir, "codepilot.plugin.json");
      let raw: string;
      try {
        raw = fs.readFileSync(manifestPath, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        malformed.push({ dir, error: `malformed manifest (invalid JSON): ${entry}/codepilot.plugin.json` });
        continue;
      }
      const validation = validatePluginManifest(parsed);
      if (!validation.valid) {
        malformed.push({ dir, error: `invalid manifest ${entry}: ${validation.errors.join("; ")}` });
        continue;
      }
      const manifest = parsed as PluginManifest;
      if (!isApiCompatible(manifest.apiVersion, this.platformVersion())) {
        malformed.push({
          dir,
          error: `incompatible apiVersion ${manifest.apiVersion} (platform ${this.platformVersion()})`,
        });
        continue;
      }
      discovered.set(manifest.id, { manifest, dir });
    }

    // Reconcile persisted intent: reinstall tool-less intents the manager
    // lost (e.g. after extension restart). Failures stay as intent + error.
    for (const [id, intent] of this.intents) {
      if (this.manager.isInstalled(id)) continue;
      const found = discovered.get(id);
      if (!found) continue;
      const installed = this.installInternal(found.manifest, intent.communityConfirmed);
      if (installed.ok && intent.enabled) {
        this.activateInternal(id, intent.communityConfirmed);
      }
    }

    const plugins: PluginView[] = [];
    const seen = new Set<string>();
    this.discoveredCache.clear();
    for (const { manifest } of discovered.values()) {
      this.discoveredCache.set(manifest.id, manifest);
      plugins.push(this.buildView(manifest, true));
      seen.add(manifest.id);
    }
    // Installed but no longer on disk → unavailable (honest error state).
    for (const installed of this.manager.listInstalled()) {
      if (seen.has(installed.id)) continue;
      const manifest = this.manager.getManifest(installed.id);
      if (!manifest) continue;
      const view = this.buildView(manifest, false);
      view.errors.push("plugin files unavailable (directory removed or unreadable)");
      plugins.push(view);
    }
    plugins.sort((a, b) => a.id.localeCompare(b.id));
    return { plugins, malformed, pluginsDir, backendAvailable: true };
  }

  // ---- Mutations (all enforced in the backend) -----------------------------

  install(
    id: string,
    options?: { confirmUntrusted?: boolean },
  ): { ok: boolean; errors: string[] } {
    if (!isValidPluginId(id)) return { ok: false, errors: ["invalid plugin id"] };
    const found = this.findDiscovered(id);
    if (!found) return { ok: false, errors: [`plugin '${id}' is not discoverable (not found on disk)`] };
    const confirmed = options?.confirmUntrusted === true;
    const result = this.installInternal(found, confirmed);
    if (!result.ok) return result;
    this.intents.set(id, {
      communityConfirmed: found.trustLevel === "community" ? true : (this.intents.get(id)?.communityConfirmed ?? false),
      enabled: this.intents.get(id)?.enabled ?? false,
    });
    this.persist();
    return { ok: true, errors: [] };
  }

  activate(
    id: string,
    options?: { confirmUntrusted?: boolean },
  ): { ok: boolean; errors: string[] } {
    if (!isValidPluginId(id)) return { ok: false, errors: ["invalid plugin id"] };
    if (!this.manager.isInstalled(id)) {
      return { ok: false, errors: [`plugin '${id}' is not installed`] };
    }
    const manifest = this.manager.getManifest(id);
    // Community (untrusted) activation ALWAYS needs an explicit per-call
    // confirmation — a prior install-time confirmation never implies it.
    // (Restart reconciliation bypasses this via activateInternal with the
    // stored intent; interactive calls go through here.)
    if (manifest?.trustLevel === "community" && options?.confirmUntrusted !== true) {
      return {
        ok: false,
        errors: ["community (untrusted) plugins require explicit enablement to activate"],
      };
    }
    const confirmed = options?.confirmUntrusted === true;
    const result = this.activateInternal(id, confirmed);
    if (!result.ok) return result;
    const intent = this.intents.get(id) ?? { communityConfirmed: false, enabled: false };
    intent.enabled = true;
    if (confirmed) intent.communityConfirmed = true;
    this.intents.set(id, intent);
    this.persist();
    return result;
  }

  deactivate(id: string): { ok: boolean; errors: string[] } {
    if (!isValidPluginId(id)) return { ok: false, errors: ["invalid plugin id"] };
    if (!this.manager.isInstalled(id)) {
      return { ok: false, errors: [`plugin '${id}' is not installed`] };
    }
    this.manager.deactivate(id);
    const intent = this.intents.get(id);
    if (intent) {
      intent.enabled = false;
      this.persist();
    }
    return { ok: true, errors: [] };
  }

  uninstall(id: string): { ok: boolean; errors: string[] } {
    if (!isValidPluginId(id)) return { ok: false, errors: ["invalid plugin id"] };
    if (!this.manager.isInstalled(id)) {
      return { ok: false, errors: [`plugin '${id}' is not installed`] };
    }
    this.manager.uninstall(id);
    this.intents.delete(id);
    this.persist();
    return { ok: true, errors: [] };
  }

  details(id: string): { ok: true; plugin: PluginView } | { ok: false; errors: string[] } {
    if (!isValidPluginId(id)) return { ok: false, errors: ["invalid plugin id"] };
    const found = this.findDiscovered(id);
    const manifest = found ?? this.manager.getManifest(id);
    if (!manifest) return { ok: false, errors: [`unknown plugin: '${id}'`] };
    return { ok: true, plugin: this.buildView(manifest, found !== undefined) };
  }

  /**
   * Execute a plugin tool through the FULL chain: ToolRegistry →
   * ToolExecutionService → M4 → handler. Fails closed without M4.
   * Proves plugins cannot bypass the security pipeline.
   */
  async invoke(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { sessionId?: string; taskId?: string; cwd?: string },
  ): Promise<{ ok: boolean; output?: unknown; error?: string }> {
    if (!isValidPluginId(pluginId)) return { ok: false, error: "invalid plugin id" };
    if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > 64) {
      return { ok: false, error: "invalid tool name" };
    }
    if (!this.m4) {
      return { ok: false, error: "backend unavailable (M4 permission pipeline not initialized)" };
    }
    if (!this.manager.isInstalled(pluginId)) {
      return { ok: false, error: `plugin '${pluginId}' is not installed` };
    }
    if (!this.manager.isEnabled(pluginId)) {
      return { ok: false, error: `plugin '${pluginId}' is not enabled` };
    }
    const toolId = `${pluginId}:${toolName}`;
    if (!this.registry.has(toolId)) {
      return { ok: false, error: `tool '${toolId}' is not registered` };
    }
    const m4Service = new ToolExecutionService(
      this.registry,
      this.permissions,
      this.audit,
      { defaultTimeoutMs: 60_000 },
      this.m4,
    );
    try {
      const result = await m4Service.execute(toolId, args ?? {}, {
        cwd: options?.cwd ?? process.cwd(),
        sessionId: options?.sessionId,
        taskId: options?.taskId,
      });
      if (result.status === "completed") {
        return { ok: true, output: result.output };
      }
      return { ok: false, error: result.error?.message ?? `execution ${result.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Number of installed plugins (lifecycle introspection for tests). */
  installedCount(): number {
    return this.manager.listInstalled().length;
  }

  /** Dispose: deactivate everything and drop listeners. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.manager.listInstalled()) {
      try {
        this.manager.deactivate(entry.id);
      } catch {
        // best effort
      }
    }
    this.execService.dispose();
  }

  // ---- Private --------------------------------------------------------------

  private platformVersion(): string {
    return this.platformApiVersion;
  }

  private findDiscovered(id: string): PluginManifest | undefined {
    return this.discoveredCache.get(id);
  }

  private installInternal(
    manifest: PluginManifest,
    communityConfirmed: boolean,
  ): { ok: boolean; errors: string[] } {
    // Handlers are never loaded from disk: only handler-less (tool-less)
    // manifests can install from discovery. Anything else is refused by the
    // REAL backend validation with an actionable error.
    const installed = this.manager.install(manifest, {}, {
      skipCommunityGate: communityConfirmed,
    });
    if (!installed.ok) return { ok: false, errors: installed.errors };
    return { ok: true, errors: [] };
  }

  private activateInternal(
    id: string,
    communityConfirmed: boolean,
  ): { ok: boolean; errors: string[] } {
    const manifest = this.manager.getManifest(id);
    if (!manifest) return { ok: false, errors: [`unknown plugin: ${id}`] };
    if (manifest.trustLevel === "community") {
      const intent = this.intents.get(id);
      if (!communityConfirmed && intent?.communityConfirmed !== true) {
        return {
          ok: false,
          errors: ["community (untrusted) plugins require explicit enablement to activate"],
        };
      }
    }
    const result = this.manager.activate(id);
    return { ok: result.ok, errors: result.errors };
  }

  private buildView(manifest: PluginManifest, discovered: boolean): PluginView {
    const installed = this.manager.isInstalled(manifest.id);
    const enabled = this.manager.isEnabled(manifest.id);
    const intent = this.intents.get(manifest.id);
    const confirmed =
      manifest.trustLevel !== "community" || intent?.communityConfirmed === true;
    const displayTrust: PluginDisplayTrust =
      manifest.trustLevel === "official"
        ? "trusted"
        : manifest.trustLevel === "verified"
          ? "verified"
          : confirmed
            ? "community"
            : "untrusted";
    const warnings: string[] = [];
    const errors: string[] = [];
    if (manifest.trustLevel === "community" && !confirmed) {
      warnings.push("untrusted source — explicit confirmation required before install and activation");
    }
    const declaredTools = manifest.tools ?? [];
    if (declaredTools.length > 0) {
      warnings.push(
        "declares executable tools — every invocation requires M4 approval per the tool permission level",
      );
    }
    for (const cap of manifest.capabilities) {
      const info = CAPABILITY_INFO[cap];
      if (info?.sensitive && manifest.trustLevel === "community") {
        warnings.push(`broad capability '${cap}' requested by an untrusted source`);
      }
    }
    const capabilities: PluginCapabilityView[] = manifest.capabilities.map((cap) => {
      const info = CAPABILITY_INFO[cap] ?? { level: "read", approval: true, sensitive: true };
      return {
        capability: cap,
        permissionLevel: info.level,
        requiresApproval: manifest.trustLevel === "community" ? true : info.approval,
        sensitive: info.sensitive,
      };
    });
    const tools: PluginToolView[] = declaredTools.map((t) => {
      const registryId = `${manifest.id}:${t.name}`;
      const registered = this.registry.has(registryId);
      let level = "read";
      let approval = manifest.trustLevel === "community";
      for (const cap of manifest.capabilities) {
        const info = CAPABILITY_INFO[cap];
        if (info) {
          if (privilegeRank(info.level) > privilegeRank(level)) level = info.level;
          if (info.approval) approval = true;
        }
      }
      return {
        name: clean(t.name, 64),
        description: clean(t.description, 300),
        registryId,
        registered,
        permissionLevel: level,
        requiresApproval: approval,
      };
    });
    if (installed && declaredTools.length > 0 && !enabled) {
      const missing = tools.filter((t) => !t.registered).map((t) => t.name);
      if (missing.length > 0) {
        errors.push(
          `tools unavailable (${missing.join(", ")}): handlers are wired by the host build, not loaded from disk`,
        );
      }
    }
    return {
      id: manifest.id,
      name: clean(manifest.name, 100),
      description: clean(manifest.description ?? "", 500),
      version: clean(manifest.version, 32),
      author: clean(manifest.author ?? (manifest.trustLevel === "official" ? "CodePilot" : "unknown"), 100),
      apiVersion: clean(manifest.apiVersion, 32),
      trustLevel: manifest.trustLevel,
      displayTrust,
      verified: true,
      installed,
      enabled,
      discovered,
      capabilities,
      tools,
      warnings,
      errors,
    };
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.save({
        installed: [...this.intents.entries()].map(([id, intent]) => ({
          id,
          communityConfirmed: intent.communityConfirmed,
          enabled: intent.enabled,
        })),
      });
    } catch {
      // best-effort persistence
    }
  }
}

function privilegeRank(level: string): number {
  const order = ["read", "write", "destructive", "execute", "network"];
  const i = order.indexOf(level);
  return i < 0 ? 99 : i;
}

export type { PluginCapability, PluginManifest, PluginTrustLevel };
export { PLUGIN_CAPABILITIES };
