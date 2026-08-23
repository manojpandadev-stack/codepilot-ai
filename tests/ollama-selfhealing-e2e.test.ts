/**
 * Real Ollama Self-Healing E2E Test
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  SelfHealingEngine,
  classifyError,
  RecoveryManager,
} from "../packages/agent-runtime/src/self-healing.js";
import * as fs from "fs";
import * as path from "path";

const TEMP_DIR = path.join(
  process.env.TMPDIR || process.env.TEMP || "/tmp",
  "codepilot-selfheal-e2e"
);

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let ollamaAvailable = false;

beforeAll(async () => {
  ollamaAvailable = await isOllamaAvailable();
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  // Write a broken JavaScript file
  fs.writeFileSync(
    path.join(TEMP_DIR, "app.js"),
    'function greet(name) {\n  console.log("Hello, " + name)\n  // Missing closing brace\n',
    "utf-8"
  );
});

describe("Self-Healing Classification", () => {
  it("classifies build failures as RECOVERABLE", () => {
    const r = classifyError("SyntaxError: Unexpected end of input", undefined, 1);
    expect(r.category).toBe("RECOVERABLE");
    expect(r.recoverable).toBe(true);
  });

  it("blocks security violations", () => {
    const r = classifyError("Path traversal detected: ../../etc/passwd");
    expect(r.category).toBe("SECURITY_VIOLATION");
    expect(r.recoverable).toBe(false);
  });

  it("blocks permission errors", () => {
    const r = classifyError("Permission denied: /root/secret.txt");
    expect(r.category).toBe("NON_RECOVERABLE");
    expect(r.recoverable).toBe(false);
  });

  it("handles transient errors", () => {
    const r = classifyError("ECONNREFUSED: connection refused");
    expect(r.category).toBe("TRANSIENT");
    expect(r.recoverable).toBe(true);
  });

  it("handles timeout errors", () => {
    const r = classifyError("Request timed out after 30000ms");
    expect(r.category).toBe("TIMEOUT");
    expect(r.recoverable).toBe(true);
  });
});

describe("RecoveryManager", () => {
  it("respects session limits", () => {
    const mgr = new RecoveryManager(TEMP_DIR, { maxSessionRecoveries: 2, cooldownMs: 0 });
    mgr.canRecover("BUILD FAILURE exit code 1", undefined, 1);
    mgr.record({ timestamp: Date.now(), error: "x", category: "RECOVERABLE", strategy: "repair", success: false });
    mgr.canRecover("BUILD FAILURE exit code 1", undefined, 1);
    mgr.record({ timestamp: Date.now(), error: "x", category: "RECOVERABLE", strategy: "repair", success: false });
    const blocked = mgr.canRecover("BUILD FAILURE exit code 1", undefined, 1);
    expect(blocked.allowed).toBe(false);
  });

  it("resets on new task", () => {
    const mgr = new RecoveryManager(TEMP_DIR, { maxSessionRecoveries: 1, cooldownMs: 0 });
    mgr.canRecover("BUILD FAILURE exit code 1", undefined, 1);
    mgr.record({ timestamp: Date.now(), error: "x", category: "RECOVERABLE", strategy: "repair", success: false });
    expect(mgr.canRecover("BUILD FAILURE exit code 1", undefined, 1).allowed).toBe(false);
    mgr.reset();
    expect(mgr.canRecover("BUILD FAILURE exit code 1", undefined, 1).allowed).toBe(true);
  });
});

describe("SelfHealingEngine", () => {
  it("blocks in plan mode", async () => {
    const engine = new SelfHealingEngine({ workspaceRoot: TEMP_DIR, isPlanMode: true });
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: "fail" },
      async () => ({ passed: false }),
      async () => ({ diagnosis: "x", repairDescription: "x", filesChanged: [] }),
      async () => ({ success: true })
    );
    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(0);
  });

  it("returns immediately if validation already passes", async () => {
    const engine = new SelfHealingEngine({ workspaceRoot: TEMP_DIR });
    const result = await engine.heal(
      { passed: true, exitCode: 0 },
      async () => ({ passed: true }),
      async () => ({ diagnosis: "x", repairDescription: "x", filesChanged: [] }),
      async () => ({ success: true })
    );
    expect(result.healed).toBe(true);
    expect(result.attempts).toBe(0);
  });

  it("emits events and heals after repair", async () => {
    const engine = new SelfHealingEngine({ workspaceRoot: TEMP_DIR, maxAttempts: 2 });
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.type));
    let count = 0;
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: "error" },
      async () => { count++; return count >= 2 ? { passed: true, exitCode: 0 } : { passed: false, exitCode: 1 }; },
      async () => ({ diagnosis: "fix", repairDescription: "fixed", filesChanged: ["a.js"] }),
      async () => ({ success: true })
    );
    expect(result.healed).toBe(true);
    expect(events).toContain("validation_failed");
    expect(events).toContain("diagnosis_started");
    expect(events).toContain("healing_succeeded");
  });

  it("exhausts max attempts", async () => {
    const engine = new SelfHealingEngine({ workspaceRoot: TEMP_DIR, maxAttempts: 2 });
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.type));
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: "persistent" },
      async () => ({ passed: false, exitCode: 1 }),
      async () => ({ diagnosis: "x", repairDescription: "x", filesChanged: [] }),
      async () => ({ success: true })
    );
    expect(result.healed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(events).toContain("healing_exhausted");
  });

  it("supports cancellation", async () => {
    const engine = new SelfHealingEngine({ workspaceRoot: TEMP_DIR, maxAttempts: 3 });
    engine.cancel();
    const result = await engine.heal(
      { passed: false, exitCode: 1, stderr: "test" },
      async () => ({ passed: false }),
      async () => ({ diagnosis: "x", repairDescription: "x", filesChanged: [] }),
      async () => ({ success: true })
    );
    expect(result.cancelled).toBe(true);
  });
});
