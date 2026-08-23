import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  // Bundled ESM dependencies (e.g. @jerome-benoit/sap-ai-provider via @cline/*)
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

async function main() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    await extCtx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
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
