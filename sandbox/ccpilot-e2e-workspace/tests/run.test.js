// Tiny assertion-based test runner (no external deps).
const assert = require("node:assert");
const { add, multiply } = require("../src/calc.js");
const { greet } = require("../src/greet.js");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}

test("add(2, 2) === 4", () => {
  assert.strictEqual(add(2, 2), 4);
});

test("add(0, 5) === 5", () => {
  assert.strictEqual(add(0, 5), 5);
});

test("add(-1, 1) === 0", () => {
  assert.strictEqual(add(-1, 1), 0);
});

test("multiply(3, 4) === 12", () => {
  assert.strictEqual(multiply(3, 4), 12);
});

test("greet returns a greeting", () => {
  assert.strictEqual(greet("Dev"), "Hello, Dev!");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(
    `${r.ok ? "PASS" : "FAIL"} — ${r.name}${r.ok ? "" : ` (${r.error})`}`,
  );
}
console.log(
  `\n${results.length - failed.length}/${results.length} tests passed`,
);
process.exit(failed.length > 0 ? 1 : 0);
