import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * LIVE Ollama suites — run with `pnpm test:live`.
 *
 * All live suites share ONE local Ollama instance (http://127.0.0.1:11434).
 * Vitest's default parallel file workers make several suites load/serve
 * qwen3:8b simultaneously, oversubscribing the model server and producing
 * spurious timeouts. This config runs the live files strictly serially
 * (one file at a time, no intra-file concurrency) so each suite gets
 * exclusive access to the shared instance.
 *
 * Only execution scheduling differs from the deterministic run: assertions
 * and per-test timeouts are unchanged, and no production code is touched.
 * Suites self-gate (honest, logged skip) when no Ollama server is reachable.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "tests/vscode-stub.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/ollama-integration.test.ts",
      "tests/ollama-transport-live.test.ts",
      "tests/agent-terminal-sessions-live.test.ts",
      "tests/skills-live-ollama.test.ts",
      "tests/terminal-streaming-live.test.ts",
      "tests/vscode-integration-live.test.ts",
      "tests/ollama-perf-live.test.ts",
      "tests/tool-automation-live-3b.test.ts",
      "tests/final-journey-live.test.ts",
      "tests/security-fixes-live.test.ts",
      "tests/rc-smoke-live.test.ts",
      "tests/capability-audit-live.test.ts",
      "tests/browser-debug-loop-live.test.ts",
      "tests/deletion-approve-reject-live.test.ts",
      "tests/plan-mode-live.test.ts",
      "tests/approval-timeline-live.test.ts",
      "tests/p8-multifile-build-live.test.ts",
    ],
    passWithNoTests: true,
    testTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
