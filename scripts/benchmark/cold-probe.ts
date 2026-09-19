/**
 * Cold-import probe worker: imports one module and prints its own import
 * latency. Run in a FRESH process per sample (see harness.measureColdImport)
 * so JIT and module-cache warmth cannot leak across samples.
 *
 * Usage: tsx cold-probe.ts <file-url>
 */
const target = process.argv[2];
if (!target) {
  console.error("cold-probe: missing module URL argument");
  process.exit(2);
}
const t0 = performance.now();
await import(target);
console.log((performance.now() - t0).toFixed(3));
