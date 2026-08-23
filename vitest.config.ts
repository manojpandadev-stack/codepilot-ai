import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
