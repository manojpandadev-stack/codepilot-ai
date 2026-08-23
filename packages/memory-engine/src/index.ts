/**
 * @codepilot/memory-engine
 *
 * Three-layer memory system for CodePilot AI:
 * - Project Memory: architecture, conventions, important files, dependencies
 * - User Memory: preferred coding style, frameworks, settings
 * - Task Memory: previous attempts, decisions, errors, completed steps
 *
 * Memory is inspectable, editable, deletable, and scoped.
 * Never stores secrets.
 */

// ============================================================================
// Memory Types
// ============================================================================

export type MemoryScope = "project" | "user" | "task";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  key: string;
  value: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  tags?: string[];
  keyPrefix?: string;
  limit?: number;
}

// ============================================================================
// Memory Engine
// ============================================================================

/**
 * Three-layer memory system for CodePilot AI.
 */
export class MemoryEngine {
  private entries = new Map<string, MemoryEntry>();
  private idCounter = 0;

  /**
   * Store a memory entry.
   */
  set(
    scope: MemoryScope,
    key: string,
    value: string,
    options?: { tags?: string[]; expiresAt?: number },
  ): MemoryEntry {
    const id = `${scope}-${++this.idCounter}`;
    const now = Date.now();

    const existing = this.findByScopeAndKey(scope, key);
    if (existing) {
      const updated: MemoryEntry = {
        ...existing,
        value,
        tags: options?.tags ?? existing.tags,
        updatedAt: now,
        expiresAt: options?.expiresAt,
      };
      this.entries.set(updated.id, updated);
      return updated;
    }

    const entry: MemoryEntry = {
      id,
      scope,
      key,
      value,
      tags: options?.tags ?? [],
      createdAt: now,
      updatedAt: now,
      expiresAt: options?.expiresAt,
    };

    this.entries.set(id, entry);
    return entry;
  }

  /**
   * Retrieve a memory entry.
   */
  get(scope: MemoryScope, key: string): MemoryEntry | undefined {
    return this.findByScopeAndKey(scope, key);
  }

  /**
   * Query memory entries.
   */
  query(query: MemoryQuery): MemoryEntry[] {
    let results = Array.from(this.entries.values());

    // Filter expired entries
    const now = Date.now();
    results = results.filter((e) => !e.expiresAt || e.expiresAt > now);

    if (query.scope) {
      results = results.filter((e) => e.scope === query.scope);
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((e) =>
        query.tags!.some((tag) => e.tags.includes(tag)),
      );
    }

    if (query.keyPrefix) {
      results = results.filter((e) => e.key.startsWith(query.keyPrefix!));
    }

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * Delete a memory entry.
   */
  delete(scope: MemoryScope, key: string): boolean {
    const entry = this.findByScopeAndKey(scope, key);
    if (entry) {
      this.entries.delete(entry.id);
      return true;
    }
    return false;
  }

  /**
   * Clear all entries for a scope.
   */
  clearScope(scope: MemoryScope): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.scope === scope) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Export all memory as JSON-serializable data.
   */
  export(): MemoryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Import memory entries.
   */
  import(entries: MemoryEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  /**
   * Get memory summary for system prompt injection.
   */
  getSummaryForPrompt(maxTokens = 500): string {
    const projectMemory = this.query({ scope: "project", limit: 10 });
    const userMemory = this.query({ scope: "user", limit: 10 });

    const parts: string[] = [];

    if (projectMemory.length > 0) {
      parts.push("## Project Memory");
      for (const entry of projectMemory) {
        parts.push(`- ${entry.key}: ${entry.value}`);
      }
    }

    if (userMemory.length > 0) {
      parts.push("## User Preferences");
      for (const entry of userMemory) {
        parts.push(`- ${entry.key}: ${entry.value}`);
      }
    }

    const summary = parts.join("\n");

    // Truncate if too long (rough token estimate: 4 chars per token)
    const maxChars = maxTokens * 4;
    if (summary.length > maxChars) {
      return summary.slice(0, maxChars) + "\n... [truncated]";
    }

    return summary;
  }

  /**
   * Sanitize a value to ensure no secrets are stored.
   */
  static sanitizeValue(value: string): string {
    const secretPatterns = [
      /api[_-]?key[:\s]*[=:]\s*\S+/gi,
      /secret[:\s]*[=:]\s*\S+/gi,
      /password[:\s]*[=:]\s*\S+/gi,
      /token[:\s]*[=:]\s*\S+/gi,
      /bearer\s+\S+/gi,
      /sk-[a-zA-Z0-9]+/g,
    ];

    let sanitized = value;
    for (const pattern of secretPatterns) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized;
  }

  // ---- Private ----

  private findByScopeAndKey(
    scope: MemoryScope,
    key: string,
  ): MemoryEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.scope === scope && entry.key === key) {
        return entry;
      }
    }
    return undefined;
  }
}
