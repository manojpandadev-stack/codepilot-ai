import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Minimal `vscode` API stub so extension-source modules that only touch
      // SecretStorage/globalState can be unit-tested without a VS Code host.
      vscode: path.resolve(__dirname, "tests/vscode-stub.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      // LIVE Ollama suites share one local Ollama instance
      // (http://127.0.0.1:11434). They are excluded from the deterministic
      // run and executed strictly serially via `pnpm test:live`
      // (vitest.live.config.ts, fileParallelism: false) so parallel workers
      // never contend for the single shared model server.
      "tests/**/*live*.test.ts",
      "tests/ollama-integration.test.ts",
    ],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
