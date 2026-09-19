import * as esbuild from "esbuild";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: [
    "vscode",
    // playwright-core must NOT be inlined: it resolves browsers.json and
    // helper modules relative to its own package directory at runtime, which
    // breaks when bundled into dist/extension.js. Instead it stays external
    // and the whole package is vendored into dist/node_modules/ below, so
    // require('playwright-core') from the bundle resolves to the real folder
    // (works identically in the VSIX: "files": ["dist/**"] ships it).
    "playwright-core",
    // playwright-core lazy-requires chromium-bidi inside its BiDi-over-CDP
    // path (init_bidiOverCdp). CodePilot uses the default CDP connection, so
    // that path is never executed; the module isn't installable standalone
    // (not a published dependency of playwright-core), so it must stay a
    // runtime require rather than a bundling error.
    "chromium-bidi",
  ],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  // Bundled ESM dependencies (e.g. @jerome-benoit/sap-ai-provider)
  // call createRequire(import.meta.url) at module top-level. esbuild's default
  // CJS shim leaves import.meta.url undefined, crashing activation with
  // "The argument 'filename' must be a file URL object..." before activate()
  // runs. Define it to the real file URL of this bundle instead.
  banner: {
    js: "var __import_meta_url = require(\"url\").pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__import_meta_url",
  },
};

/**
 * Vendor playwright-core into dist/node_modules/ so the external require in
 * the bundle resolves at runtime (dev and packaged VSIX alike). Resolved
 * through browser-engine's dependency graph so the pnpm store path is never
 * hardcoded. playwright-core has zero runtime dependencies — one folder is
 * the complete vendor set.
 */
function vendorPlaywrightCore() {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const req = createRequire(resolve(repoRoot, "packages/browser-engine/package.json"));
  const pwDir = dirname(req.resolve("playwright-core/package.json"));
  const dest = resolve("dist/node_modules/playwright-core");
  cpSync(pwDir, dest, { recursive: true });
}

async function main() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    await extCtx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
    vendorPlaywrightCore();
    const webviewBundle = resolve("../webview/dist/webview.js");
    mkdirSync("dist", { recursive: true });
    copyFileSync(webviewBundle, resolve("dist/webview.js"));
    console.log("Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
