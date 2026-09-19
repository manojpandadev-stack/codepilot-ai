import * as esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  outfile: "dist/cli.js",
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["@modelcontextprotocol/*"],
  sourcemap: false,
  minify: false,
});
console.log("CLI built → dist/cli.js");
