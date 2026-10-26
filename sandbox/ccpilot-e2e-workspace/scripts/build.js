// Real build: concatenate the source modules into dist/bundle.js.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "dist");
const outFile = path.join(outDir, "bundle.js");

try {
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".js"))
    .sort();
  if (files.length === 0) {
    console.error("build failed: no source files found");
    process.exit(1);
  }
  const banner = "// ccpilot-e2e-calc bundle — generated, do not edit\n";
  const body = files
    .map(
      (f) =>
        `// ---- ${f} ----\n` + fs.readFileSync(path.join(srcDir, f), "utf8"),
    )
    .join("\n");
  fs.writeFileSync(outFile, banner + body, "utf8");
  console.log(`build ok: ${files.length} modules → dist/bundle.js`);
  process.exit(0);
} catch (err) {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
