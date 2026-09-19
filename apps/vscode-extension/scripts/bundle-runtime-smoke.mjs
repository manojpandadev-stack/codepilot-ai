/**
 * Runtime bundle smoke — bundles a minimal entry (BrowserService only) with
 * the extension's esbuild settings, then EXECUTES the bundle: launch system
 * Chrome → navigate a local page → assert → dispose. Proves playwright-core
 * works from inside an esbuild CJS bundle (the VSIX packaging model).
 */
import { build } from "esbuild";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "..");

const ENTRY = `\
import { BrowserService } from "@codepilot/browser-engine";
import * as http from "node:http";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><title>Bundle Runtime OK</title><body>hi</body></html>");
});

server.listen(18126, "127.0.0.1", async () => {
  const svc = new BrowserService({ channel: process.env.BROWSER_CHANNEL || undefined, urlPolicy: { allowPrivateNetworks: true } });
  try {
    const r = await svc.navigate("bundle-task", "default", "http://127.0.0.1:18126/");
    if (!r.ok || r.title !== "Bundle Runtime OK") {
      console.error("RUNTIME_FAIL", JSON.stringify(r));
      process.exit(1);
    }
    console.log("RUNTIME_BUNDLE_OK title=" + r.title);
    await svc.dispose();
    process.exit(0);
  } catch (e) {
    console.error("RUNTIME_FAIL", e && e.message);
    process.exit(1);
  } finally {
    server.close();
  }
});
`;

async function main() {
  await build({
    stdin: { contents: ENTRY, resolveDir: here, loader: "js" },
    bundle: true,
    outfile: "dist/bundle-runtime.tmp.js",
    external: ["vscode", "chromium-bidi", "playwright-core"],
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

  // Mirror the real build: vendor playwright-core next to the bundle so the
  // external require resolves (this is exactly what esbuild.mjs now does for
  // the shipped extension).
  const { createRequire } = await import("node:module");
  const { cpSync } = await import("node:fs");
  const repoRoot = path.resolve(extRoot, "../..");
  const req = createRequire(path.join(repoRoot, "packages/browser-engine/package.json"));
  const pwDir = path.dirname(req.resolve("playwright-core/package.json"));
  cpSync(pwDir, path.join(extRoot, "dist/node_modules/playwright-core"), { recursive: true });

  // Discover channel with the same logic as the extension (inline to avoid
  // Node's TS-strip limitations on parameter properties).
  const fs = await import("node:fs");
  const candidates = [
    ["chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
    ["chrome", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
    ["chrome", "/usr/bin/google-chrome"],
    ["msedge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"],
    ["msedge", "/usr/bin/microsoft-edge"],
  ];
  let channel = null;
  for (const [ch, p] of candidates) {
    try {
      if (fs.existsSync(p)) { channel = ch; break; }
    } catch { /* keep scanning */ }
  }
  if (!channel) {
    console.error("RUNTIME_SKIP no system browser");
    process.exit(2);
  }
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, [path.join(extRoot, "dist/bundle-runtime.tmp.js")], {
    env: { ...process.env, BROWSER_CHANNEL: channel ?? "" },
    encoding: "utf8",
    timeout: 90_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (out.includes("RUNTIME_BUNDLE_OK")) {
    console.log(out.trim().split("\n").filter((l) => l.includes("RUNTIME_BUNDLE_OK")).join("\n"));
    process.exit(0);
  }
  console.error("RUNTIME_BUNDLE_FAIL", out.slice(0, 600));
  process.exit(1);
}

main().catch((e) => {
  console.error("RUNTIME_BUNDLE_FAIL", e?.message ?? e);
  process.exit(1);
});
