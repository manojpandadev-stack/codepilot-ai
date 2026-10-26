/**
 * END-TO-END PRODUCT VALIDATION — real extension, real Ollama, real M4.
 *
 * Drives the actual extension module (vscode stub for the API surface only)
 * through a complete product workflow against a disposable workspace
 * (sandbox/ccpilot-e2e-workspace: calc.js `add` bug + real test/build
 * scripts):
 *
 *   PHASE 3/4  real agent leg (qwen2.5-coder:3b): inspect → fix src/calc.js
 *              → run tests → ChangeSet staged → completed
 *   PHASE 5    lifecycle events captured (agent/status, tool events, usage)
 *   PHASE 6    real M4 approval round-trip (tool/request_approval →
 *              tool/approval_result through the real dispatcher)
 *   PHASE 7    Verification Engine: tests+build run for real; security is
 *              honestly NOT_AVAILABLE (no security script in the fixture)
 *   PHASE 9    negative verification: re-broken source must NOT verify
 *   PHASE 10   cancellation: cancelled runs never verify
 *   PHASE 11   reopenHost: no corruption, no fabricated verification state
 *
 * Evidence notes: every phase records what actually happened. The agent leg
 * is skipped (honestly) when no local Ollama server is reachable — the
 * remaining phases run standalone.
 *
 * The fixture source is reset to its buggy state in a final afterAll so the
 * disposable workspace stays reproducible for future runs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  reopenHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import {
  runVerification,
  planVerification,
} from "../packages/tool-engine/src/verification-engine.js";
import type {
  WebviewMessage,
  VerificationStatePayload,
} from "@codepilot/shared";

// The repo fixture is a TEMPLATE. Every validation run gets its OWN COPY in
// the OS temp dir, so concurrent runs (parallel suite + standalone live run)
// never observe each other's edits through shared mutable state.
const TEMPLATE = path.resolve(__dirname, "..", "sandbox/ccpilot-e2e-workspace");
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ccpilot-e2e-ws-"));

function initWorkspace(
  targetDir: string,
  templatePath: string = TEMPLATE,
): void {
  if (fs.existsSync(templatePath)) {
    fs.cpSync(templatePath, targetDir, { recursive: true });
    return;
  }
  // Resilient fallback: synthesize the template files if missing
  fs.mkdirSync(path.join(targetDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: "ccpilot-e2e-calc",
        version: "1.0.0",
        private: true,
        description:
          "Disposable validation workspace for CodePilot E2E product testing",
        scripts: {
          test: "node tests/run.test.js",
          build: "node scripts/build.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(targetDir, "src", "calc.js"),
    "function add(a, b) {\n  return a - b;\n}\nfunction multiply(a, b) {\n  return a * b;\n}\nmodule.exports = { add, multiply };\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(targetDir, "src", "greet.js"),
    "function greet(name) {\n  return `Hello, ${name}!`;\n}\nmodule.exports = { greet };\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(targetDir, "scripts", "build.js"),
    'const fs = require("node:fs");\nconst path = require("node:path");\nconst srcDir = path.join(__dirname, "..", "src");\nconst outDir = path.join(__dirname, "..", "dist");\nfs.mkdirSync(outDir, { recursive: true });\nconst files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort();\nconst body = files.map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\\n");\nfs.writeFileSync(path.join(outDir, "bundle.js"), body, "utf8");\nprocess.exit(0);\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(targetDir, "tests", "run.test.js"),
    'const assert = require("node:assert");\nconst { add, multiply } = require("../src/calc.js");\nconst { greet } = require("../src/greet.js");\nassert.strictEqual(add(2, 2), 4, "add(2, 2) === 4");\nassert.strictEqual(add(0, 5), 5, "add(0, 5) === 5");\nassert.strictEqual(add(-1, 1), 0, "add(-1, 1) === 0");\nassert.strictEqual(multiply(3, 4), 12, "multiply(3, 4) === 12");\nassert.strictEqual(greet("Dev"), "Hello, Dev!", "greet returns a greeting");\nconsole.log("5/5 tests passed");\nprocess.exit(0);\n',
    "utf8",
  );
}

initWorkspace(WORKSPACE);
const CALC = path.join(WORKSPACE, "src", "calc.js");
const Buggy = "return a - b;";
const Fixed = "return a + b;";

const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_UP = await fetch(`${OLLAMA_URL}/api/tags`, {
  signal: AbortSignal.timeout(4000),
})
  .then((r) => r.ok)
  .catch(() => false);

// The real-agent leg needs a LOCAL MODEL and runs for MINUTES on CPU. In the
// parallel deterministic suite that is exactly the live-suite antipattern the
// repo separates out (vitest.live.config.ts, fileParallelism:false). The leg
// is therefore gated behind CCPILOT_E2E_LIVE=1: the deterministic suite
// validates everything else; the live leg runs on demand (it PASSED 6/6
// standalone — see vfy-e2e3.log). skipIf keeps the file runnable both ways.
const LIVE_LEG = OLLAMA_UP && process.env.CCPILOT_E2E_LIVE === "1";

// ============================================================================
// Harness state
// ============================================================================

let host: FreshHost;
const sent: WebviewMessage[] = [];
let approvalResolver:
  ((approvalId: string, decision: "allow" | "deny") => void) | null = null;

function agentStatuses(): string[] {
  return sent
    .filter((m) => m.type === "agent/status")
    .map((m) => (m.payload as { status?: string }).status ?? "?");
}

function toolEvents(): Array<{ type: string; name: string }> {
  return sent
    .filter(
      (m) =>
        m.type === "tool/started" ||
        m.type === "tool/completed" ||
        m.type === "tool_failed",
    )
    .map((m) => ({
      type: m.type,
      name: (m.payload as { toolName?: string }).toolName ?? "?",
    }));
}

function verificationStates(): VerificationStatePayload[] {
  return sent
    .filter((m) => m.type === "verification/state")
    .map((m) => m.payload as VerificationStatePayload);
}

function lastVerification(): VerificationStatePayload | undefined {
  const states = verificationStates();
  return states[states.length - 1];
}

async function runAgentLeg(): Promise<void> {
  approvalResolver = (approvalId, decision) => {
    void host.seams.handleMessage({
      type: "tool/approval_result",
      id: `wv-approval-${approvalId}`,
      payload: { approvalId, decision, scope: "once" },
      timestamp: Date.now(),
    });
  };
  void host.seams.runPrompt(
    "Fix the bug in src/calc.js: add(a, b) returns a - b but must return a + b. " +
      "Read the file first, then edit it. When done, run the project tests with " +
      "'node tests/run.test.js' and confirm they pass.",
    "act",
  );
  // Wait for completion (host emits agent/status completed) — bounded.
  // qwen3:8b on CPU with a 24-iteration budget legitimately runs 300-900s
  // (measured: one earlier validation PASS took 357.9s; retries have hit
  // the old 650s window before the terminal status arrived). 850s covers
  // the documented range with headroom.
  const deadline = Date.now() + 850_000;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const statuses = agentStatuses();
    if (
      statuses.includes("completed") ||
      statuses.includes("idle") ||
      statuses.includes("error") ||
      statuses.includes("failed")
    ) {
      break;
    }
  }
}

// ============================================================================
// PHASE 1-2 evidence lives in the report (build/package/install). The
// lifecycle phases run against the REAL extension module here.
// ============================================================================

describe.skipIf(!LIVE_LEG)(
  "CodePilot product E2E — real extension + real agent",
  { timeout: 900_000 },
  () => {
    beforeAll(async () => {
      host = await freshHost();
      host.vscodeStub.workspace.workspaceFolders.length = 0;
      host.vscodeStub.workspace.workspaceFolders.push({
        uri: { fsPath: WORKSPACE },
      });
      // Real local model with KNOWN tool-calling support (the 3b coder
      // variant answers text-only in this runtime — a model limitation,
      // recorded in the report). Bounded turn budget, transport opted in
      // (CPU prefill can exceed undici's 300s headers timeout).
      host.vscodeStub.configOverrides.set("model", "qwen3:8b");
      host.vscodeStub.configOverrides.set("maxIterations", 24);
      host.vscodeStub.configOverrides.set(
        "localAI.ollama.useNodeHttpTransport",
        true,
      );
      host.vscodeStub.configOverrides.set("localAI.ollama.think", "disabled");
      // Warm the model so the timed test does not pay the cold load.
      await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3:8b",
          prompt: "ok",
          num_predict: 1,
          keep_alive: "60m",
        }),
        signal: AbortSignal.timeout(300_000),
      }).catch(() => undefined);
      // Capture everything the host sends to the webview. Realistic user
      // behavior: M4 approvals are ALLOWED (the user is watching the run);
      // the staged ChangeSet is then ACCEPTED like a real Changes-tab click,
      // so the fix lands on disk through the real diff/accept_all path.
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        const msg = m as WebviewMessage;
        sent.push(msg);
        if (msg.type === "tool/request_approval" && approvalResolver) {
          const p = msg.payload as { approvalId: string };
          setTimeout(() => approvalResolver!(p.approvalId, "allow"), 25);
        }
        if (msg.type === "diff/created") {
          const p = msg.payload as { changeSetId: string };
          setTimeout(() => {
            void host.seams.handleMessage({
              type: "diff/accept_all",
              id: `wv-accept-${p.changeSetId}`,
              payload: { changeSetId: p.changeSetId },
              timestamp: Date.now(),
            });
          }, 60);
        }
      });
    }, 330_000);

    afterAll(async () => {
      // The run used its OWN workspace copy — nothing to restore.
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    });

    it("PHASE 4/5/6 — agent inspects, fixes, verifies behavior, stages a ChangeSet, completes", async () => {
      // Baseline: the workspace test actually fails before the agent works.
      const before = await runVerification({
        workspaceRoot: WORKSPACE,
        checks: ["tests"],
        timeoutMs: 30_000,
      });
      expect(before.verdict).toBe("failed");

      await runAgentLeg();

      // Small local models sometimes answer text-only without touching any
      // tool. That is a MODEL limitation, not a product one — give the agent
      // one explicit retry before judging the product.
      if (toolEvents().length === 0) {
        await runAgentLeg();
      }

      // Lifecycle: the run started and settled (real agent/status events).
      const statuses = agentStatuses();
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses[0]).toBe("running");
      if (!statuses.includes("completed") && !statuses.includes("idle")) {
        // Honest failure naming the actual terminal state.
        throw new Error(
          `agent leg did not reach a settled state — statuses=[${statuses.join(",")}]`,
        );
      }

      // Tool activity: the agent actually inspected the workspace.
      const names = toolEvents().map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(
        names.some((n) =>
          /read|inspect|search|terminal|bash|edit|write|apply/i.test(n),
        ),
      ).toBe(true);

      // Usage evidence arrived with completion. KNOWN FINDING (recorded,
      // not hidden): qwen2.5-coder:3b currently reports 0 tokens — the
      // assertion only requires the usage field with numeric counts.
      const completed = sent.find(
        (m) =>
          m.type === "agent/status" &&
          (m.payload as { status?: string }).status === "completed",
      );
      expect(completed).toBeDefined();
      const usage = (completed!.payload as { usage?: { inputTokens?: number } })
        .usage;
      expect(typeof usage?.inputTokens).toBe("number");

      // Deterministic outcome: the bug is fixed on disk (or a ChangeSet with
      // the fix is staged awaiting approval — both are legitimate product
      // behaviors; a silent no-op is not).
      const src = fs.readFileSync(CALC, "utf8");
      const fixedOnDisk = src.includes(Fixed) && !src.includes(Buggy);
      const diffCreated = sent.some(
        (m) =>
          m.type === "diff/created" &&
          JSON.stringify(m.payload).includes("calc.js"),
      );
      expect(fixedOnDisk || diffCreated).toBe(true);

      // Post-state: tests pass now (the whole point of the task).
      const after = await runVerification({
        workspaceRoot: WORKSPACE,
        checks: ["tests"],
        timeoutMs: 30_000,
      });
      expect(after.verdict).toBe("verified");
    });
  },
);

// ============================================================================
// PHASE 7 — Verification Engine against the disposable workspace
// ============================================================================

describe("PHASE 7 — verification engine (real commands)", () => {
  it("plans tests+build from the fixture's real scripts; security is NOT_AVAILABLE", () => {
    const plan = planVerification(WORKSPACE);
    const types = plan.checks.map((c) => c.type);
    expect(types).toContain("tests");
    expect(types).toContain("build");
    const security = plan.skipped.find((s) => s.type === "security");
    expect(security).toBeDefined();
    expect(security!.reason).toContain("no security script");
  });

  it("initializes a valid fallback workspace even if template directory is absent", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ccpilot-fallback-test-"),
    );
    try {
      initWorkspace(tempDir, path.join(tempDir, "nonexistent-template"));
      expect(fs.existsSync(path.join(tempDir, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "src", "calc.js"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "tests", "run.test.js"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(tempDir, "scripts", "build.js"))).toBe(
        true,
      );
      const plan = planVerification(tempDir);
      expect(plan.checks.map((c) => c.type)).toContain("tests");
      expect(plan.checks.map((c) => c.type)).toContain("build");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tests + build run for real; exit statuses map honestly", async () => {
    // This phase shares the workspace with the agent leg, which (when it
    // succeeds) FIXES calc.js on disk. Reset the bug so the phase under
    // test — honest failure mapping — is order-independent.
    const src = fs.readFileSync(CALC, "utf8");
    if (!src.includes(Buggy)) {
      fs.writeFileSync(CALC, src.replace(Fixed, Buggy), "utf8");
    }
    const result = await runVerification({
      workspaceRoot: WORKSPACE,
      timeoutMs: 60_000,
    });
    const byType = new Map(result.checks.map((c) => [c.type, c]));
    expect(byType.get("tests")!.status).toBe("failed");
    expect(byType.get("tests")!.exitCode).toBe(1);
    expect(byType.get("tests")!.error).toContain("add(2, 2)");
    expect(byType.get("build")!.status).toBe("passed");
    expect(byType.get("build")!.exitCode).toBe(0);
    expect(byType.get("security")!.status).toBe("not_available");
    // Aggregate: failed + passed + not_available → FAILED (conservative).
    expect(result.verdict).toBe("failed");
  });
});

// ============================================================================
// PHASE 9 — negative verification (critical acceptance test)
// ============================================================================

describe("PHASE 9 — negative verification", () => {
  it("a re-broken workspace must NEVER verify — even though build passes", async () => {
    // Order-independence: restore the buggy source first (the agent leg
    // may have fixed it), then break the BUILD for a second signal.
    const src = fs.readFileSync(CALC, "utf8");
    if (!src.includes(Buggy)) {
      fs.writeFileSync(CALC, src.replace(Fixed, Buggy), "utf8");
    }
    const buildJs = path.join(WORKSPACE, "scripts", "build.js");
    const original = fs.readFileSync(buildJs, "utf8");
    fs.writeFileSync(
      buildJs,
      original.replace("process.exit(0);", "process.exit(7);"),
      "utf8",
    );
    try {
      const result = await runVerification({
        workspaceRoot: WORKSPACE,
        timeoutMs: 60_000,
      });
      const byType = new Map(result.checks.map((c) => [c.type, c]));
      expect(byType.get("tests")!.status).toBe("failed");
      expect(byType.get("build")!.status).toBe("failed");
      expect(byType.get("build")!.exitCode).toBe(7);
      expect(result.verdict).toBe("failed");
      expect(result.verdict).not.toBe("verified");
    } finally {
      fs.writeFileSync(buildJs, original, "utf8");
    }
  });
});

// ============================================================================
// PHASE 10 — cancellation
// ============================================================================

describe("PHASE 10 — cancellation", () => {
  it("a cancelled verification run is CANCELLED / NOT VERIFIED — never verified", async () => {
    const controller = new AbortController();
    const pending = runVerification({
      workspaceRoot: WORKSPACE,
      checks: ["tests"],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    const tests = result.checks.find((c) => c.type === "tests")!;
    expect(tests.status).toBe("cancelled");
    expect(result.verdict).toBe("not_verified");
    expect(result.verdict).not.toBe("verified");
  });
});

// ============================================================================
// PHASE 11 — reload / continuity
// ============================================================================

describe("PHASE 11 — reload continuity", () => {
  it("reopen keeps task state valid and replays honest verification state", async () => {
    const first = await freshHost();
    first.vscodeStub.workspace.workspaceFolders.length = 0;
    first.vscodeStub.workspace.workspaceFolders.push({
      uri: { fsPath: WORKSPACE },
    });
    first.vscodeStub.configOverrides.set("model", "qwen2.5-coder:3b");
    try {
      const taskId = await first.seams.beginTask("validation continuity task");
      expect(taskId).toBeTruthy();
      const verifyMessages: WebviewMessage[] = [];
      first.ext.__setWebviewSinkForIntegrationTest((m) =>
        verifyMessages.push(m as WebviewMessage),
      );

      // Crash-style reopen against the SAME storage.
      const reopened = await reopenHost(first.storageDir, false);
      reopened.vscodeStub.workspace.workspaceFolders.length = 0;
      reopened.vscodeStub.workspace.workspaceFolders.push({
        uri: { fsPath: WORKSPACE },
      });
      reopened.ext.__setWebviewSinkForIntegrationTest((m) =>
        verifyMessages.push(m as WebviewMessage),
      );

      // verification/get after reload: honest state (no run yet in the new
      // session → explicit not_available, never a fabricated verdict).
      await reopened.seams.handleMessage({
        type: "verification/get",
        id: `wv-get-${Date.now()}`,
        payload: {},
        timestamp: Date.now(),
      });
      await sleep(150);
      const states = verifyMessages.filter(
        (m) => m.type === "verification/state",
      );
      expect(states.length).toBeGreaterThan(0);
      const state = states[states.length - 1]!
        .payload as VerificationStatePayload;
      expect(state.verdict).toBe("not_available");
      expect(state.summary).toContain("No verification has run");

      // Task history survives the reopen.
      const store = reopened.seams.getTaskStore();
      const task = await store.get(taskId!);
      expect(task).not.toBeNull();

      reopened.ext.__clearWebviewSinkForIntegrationTest();
      first.ext.__clearWebviewSinkForIntegrationTest();
      await first.ext.deactivate().catch(() => {});
      await reopened.ext.deactivate().catch(() => {});
      first.cleanup();
    } finally {
      first.vscodeStub.configOverrides.delete("model");
    }
  });
});

afterAll(() => {
  try {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  } catch {}
});
