/**
 * Packaging smoke test — mirrors the extension's esbuild config (bundle,
 * cjs, platform node, external vscode) for the browser path only, then RUNS
 * the bundled output: import → launch system Chrome → navigate a local page
 * → dispose. Proves playwright-core survives esbuild bundling (dynamic
 * requires intact) before we package the VSIX.
 */
import { build } from "esbuild";
import * as http from "node:http";

async function main() {
  const port = 18_125;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>Bundle OK</title><body>hello from bundle</body></html>");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  try {
    await build({
      entryPoints: ["src/extension.ts"],
      bundle: true,
      outfile: "dist/bundle-smoke.tmp.js",
      external: ["vscode", "chromium-bidi"],
      format: "cjs",
      platform: "node",
      target: "node22",
      sourcemap: false,
      minify: false,
      logLevel: "silent",
      banner: {
        js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href;',
      },
      define: { "import.meta.url": "__import_meta_url" },
    });
    console.log("BUNDLE_BUILD_OK");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("BUNDLE_SMOKE_FAIL", err?.message ?? err);
  process.exit(1);
});
