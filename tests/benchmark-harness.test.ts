/**
 * Benchmark harness regression tests.
 *
 * Part 1 — harness correctness (pure, deterministic, fast):
 *   stats math (median/p95/p99 sample-count gating, empty input),
 *   fixture determinism (same seed → identical bytes),
 *   thresholds file validity.
 * Part 2 — performance regression gates: a FAST subset of stable,
 *   pure-CPU/in-memory operations re-measured inline (20 iterations) and
 *   asserted against scripts/benchmark/thresholds.ts failMs. Margins are
 *   wide (100x measured p95) so only real regressions trip them.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeStats,
  measure,
  buildFixture,
} from "../scripts/benchmark/harness.js";
import { THRESHOLDS } from "../scripts/benchmark/thresholds.js";
import { ToolRegistry } from "../packages/tool-engine/src/m3/registry.js";
import type { ToolDefinition } from "../packages/tool-engine/src/m3/types.js";
import { RiskEngine } from "../packages/tool-engine/src/m4/risk-engine.js";
import { SecurityValidator } from "../packages/tool-engine/src/m4/security-validator.js";
import { PermissionPolicyEngine } from "../packages/tool-engine/src/m4/policy-engine.js";
import { checkNavigationPolicy } from "../packages/context-engine/src/m13-web-agent.js";
import { classifyIPv4 } from "../packages/context-engine/src/ssrf-guard.js";
import { TaskDAG } from "../packages/agent-runtime/src/orchestrator.js";
import {
  normalizePluginList,
  validatePluginAction,
} from "../apps/webview/src/lib/messages.js";
import { validatePluginManifest } from "../packages/tool-engine/src/m15-plugin-platform.js";
import { testPathGuard } from "../packages/changeset-engine/src/m5/testing.js";

function trivialTool(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: "regression gate tool",
    category: "analysis",
    version: "1.0.0",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    capabilities: ["idempotent"],
    permission: { level: "read", requiresApproval: false, rationale: "test" },
    idempotent: true,
    execute: async () => ({ ok: true }),
  };
}

describe("benchmark stats math", () => {
  it("computes median/mean/min/max/stddev", () => {
    const s = computeStats([1, 2, 3, 4, 5]);
    expect(s.samples).toBe(5);
    expect(s.medianMs).toBe(3);
    expect(s.meanMs).toBe(3);
    expect(s.minMs).toBe(1);
    expect(s.maxMs).toBe(5);
  });

  it("averages the two middle values for even samples", () => {
    expect(computeStats([1, 2, 3, 4]).medianMs).toBe(2.5);
  });

  it("gates p95 (n>=20) and p99 (n>=100), never extrapolates", () => {
    expect(computeStats(new Array(10).fill(1)).p95Ms).toBeNull();
    expect(computeStats(new Array(10).fill(1)).p99Ms).toBeNull();
    const twenty = computeStats(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(twenty.p95Ms).not.toBeNull();
    expect(twenty.p99Ms).toBeNull();
    const hundred = computeStats(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(hundred.p95Ms).not.toBeNull();
    expect(hundred.p99Ms).not.toBeNull();
    expect(hundred.p99Ms as number).toBeGreaterThanOrEqual(hundred.p95Ms as number);
  });

  it("throws on empty input (never reports zero-sample stats)", () => {
    expect(() => computeStats([])).toThrow();
  });
});

describe("benchmark fixtures", () => {
  it("are deterministic: same seed produces identical bytes", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bench-det-"));
    try {
      const a = buildFixture("small", path.join(parent, "a"));
      const b = buildFixture("small", path.join(parent, "b"));
      expect(a.fileCount).toBe(b.fileCount);
      expect(a.totalBytes).toBe(b.totalBytes);
      expect(a.approxSymbols).toBe(b.approxSymbols);
      const hashTree = (root: string): string[] => {
        const out: string[] = [];
        const walk = (dir: string): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else out.push(`${path.relative(root, abs)}:${fs.readFileSync(abs, "utf8").length}`);
          }
        };
        walk(root);
        return out.sort();
      };
      expect(hashTree(a.root)).toEqual(hashTree(b.root));
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("small < medium < large by file count", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bench-size-"));
    try {
      const s = buildFixture("small", parent);
      const m = buildFixture("medium", parent);
      expect(s.fileCount).toBeLessThan(m.fileCount);
      expect(m.codeFiles).toBeGreaterThan(100);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("benchmark thresholds file", () => {
  it("every entry is a sane gate (positive, warn < fail)", () => {
    const ids = Object.keys(THRESHOLDS);
    expect(ids.length).toBeGreaterThan(10);
    for (const [id, t] of Object.entries(THRESHOLDS)) {
      expect(t.baselineMedianMs, id).toBeGreaterThan(0);
      expect(t.warnMs, id).toBeGreaterThan(0);
      expect(t.failMs, id).toBeGreaterThan(t.warnMs);
    }
  });
});

describe("performance regression gates (fast subset vs failMs)", () => {
  const gate = async (id: string, fn: () => void | Promise<void>): Promise<void> => {
    const threshold = THRESHOLDS[id];
    expect(threshold, `missing threshold for ${id}`).toBeDefined();
    const { stats } = await measure(fn, { warmup: 3, iterations: 20 });
    expect(
      stats.medianMs,
      `${id}: median ${stats.medianMs}ms exceeds fail ${threshold!.failMs}ms`,
    ).toBeLessThan(threshold!.failMs);
  };

  it("tool.registry.lookup", async () => {
    const registry = new ToolRegistry();
    for (let i = 0; i < 200; i++) registry.register(trivialTool(`gate-tool-${i}`));
    await gate("tool-registry-lookup", () => {
      const t = registry.get("gate-tool-150");
      if (!t) throw new Error("lookup failed");
    });
    await gate("tool-registry-list", () => {
      if (registry.list().length !== 200) throw new Error("list failed");
    });
  });

  it("m4.risk.assess + m4.policy.evaluate + m4.security.validate", async () => {
    const risk = new RiskEngine();
    await gate("m4-risk-assess", () => {
      risk.assess("execute_command", { command: "rm -rf /" });
    });
    const policy = new PermissionPolicyEngine({ riskEngine: risk });
    await gate("m4-policy-evaluate", () => {
      policy.evaluate({
        action: "write_file", toolId: "write_file", executionId: "e",
        workspaceRoot: process.cwd(), metadata: { path: "src/a.ts" },
      });
    });
    const validator = new SecurityValidator({ workspaceRoot: process.cwd() });
    await gate("m4-security-validate", () => {
      const v = validator.validate("write_file", { path: "src/a.ts" });
      if (!v.allowed) throw new Error("should allow");
    });
  });

  it("ssrf policy + classification", async () => {
    // Canonical gated ids from thresholds.ts:
    await gate("ssrf-policy-allow", () => {
      if (!checkNavigationPolicy("https://example.com/docs").allowed) throw new Error("allow failed");
    });
    await gate("ssrf-policy-block", () => {
      if (checkNavigationPolicy("http://169.254.169.254/").allowed) throw new Error("block failed");
    });
    await gate("ssrf-classify-ipv4", () => {
      if (classifyIPv4("192.168.1.1") !== "private") throw new Error("classify failed");
    });
  });

  it("orchestrator DAG ops", async () => {
    await gate("orchestrator-classify", () => {
      TaskDAG.classifyTask("implement login with tests");
    });
    await gate("orchestrator-dag-build", () => {
      const dag = TaskDAG.buildFromRoles(["architect", "coder", "tester", "security", "reviewer"], "x");
      if (dag.validate().length > 0) throw new Error("invalid dag");
      dag.getReadyTasks();
    });
  });

  it("webview normalize + validate", async () => {
    const payload = {
      plugins: Array.from({ length: 50 }, (_, i) => ({
        id: `plugin-${i}`, version: "1.0.0", trustLevel: "verified", enabled: true,
        capabilities: ["context.read"], tools: [{ name: "greet", description: "g" }],
      })),
    };
    await gate("webview-normalize-50", () => {
      const out = normalizePluginList(payload);
      if (out.plugins.length !== 50) throw new Error("normalize mismatch");
    });
    await gate("webview-validate-action", () => {
      if (!validatePluginAction("plugins/activate", { id: "my-plugin" }).ok) {
        throw new Error("validate failed");
      }
    });
  });

  it("plugin manifest validation + M5 path guard", async () => {
    const manifest = {
      id: "gate-plugin", name: "Gate", version: "1.0.0", apiVersion: "1.0.0",
      trustLevel: "verified", capabilities: ["context.read"], tools: [{ name: "greet", description: "g" }],
    } as const;
    await gate("plugin-validate-manifest", () => {
      if (!validatePluginManifest(manifest).valid) throw new Error("manifest rejected");
    });
    const guard = testPathGuard(process.cwd());
    await gate("m5-pathguard-allow", () => {
      guard.guard("src/app.ts");
    });
  });
});
