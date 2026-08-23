import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "webview.js",
        format: "iife",
        globals: {},
      },
    },
    target: "es2022",
    sourcemap: false,
    minify: false,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
