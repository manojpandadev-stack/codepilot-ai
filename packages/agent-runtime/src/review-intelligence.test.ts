/**
 * Review intelligence — deterministic tests (no network, no model).
 *
 * Covers: ReviewReport shape, finding severity ordering, diff analysis
 * (guard/catch/approval/cancellation removal), security analysis (secrets,
 * .env, exec, traversal, auth headers), test selection (convention/graph/
 * history), failure classification (all kinds; FLAKY needs evidence), risk
 * scoring tiers, regression detection honesty, agent-claim validation (H6
 * preserved), verification recommendation (advisory only), cancellation of
 * every operation, performance boundaries, and the end-to-end fixture chain.
 */
import { describe, it, expect } from "vitest";
import {
  reviewChange,
  assessRisk,
  selectTests,
  classifyTestFailure,
  recommendVerification,
  detectRegression,
  validateCompletion,
} from "./review-intelligence.js";

const clean = (n: number): string =>
  Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

describe("ReviewReport shape", () => {
  it("clean change passes with empty findings and LOW risk", () => {
    const r = reviewChange({
      task: "Add helper",
      files: [
        {
          path: "src/util.ts",
          before: clean(5),
          after: `${clean(5)}\nexport function add(a: number, b: number): number {\n  return a + b;\n}`,
        },
        {
          path: "tests/util.test.ts",
          before: "",
          after: `import { add } from "../src/util";\nit("adds", () => {});\n`,
        },
      ],
    });
    expect(r.status).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.risk).toBe("LOW");
    expect(r.filesReviewed).toEqual(["src/util.ts", "tests/util.test.ts"]);
    expect(r.securityChecks).toContain("secret-scan");
    expect(r.recommendations).toEqual([]);
  });

  it("findings sort critical-first then by file/line", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/a.ts",
          before: "const x = 1;",
          after: "const x = 1;\n// TODO: cleanup\neval(userInput);",
        },
      ],
    });
    expect(r.status).toBe("fail");
    expect(r.findings[0]!.severity).toBe("critical");
    expect(r.findings[0]!.category).toBe("SECURITY");
  });
});

describe("diff analysis", () => {
  it("flags removed validation guards", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/auth.ts",
          before:
            "if (!isValid(token)) {\n  throw new Error('bad');\n}\nproceed();",
          after: "proceed();",
        },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.category === "ERROR_HANDLING" && /validation/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags removed catch blocks", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/run.ts",
          before: "try {\n  work();\n} catch (e) {\n  log(e);\n}",
          after: "work();",
        },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.severity === "high" && f.category === "ERROR_HANDLING",
      ),
    ).toBe(true);
  });

  it("flags removed approval checks as critical", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/gate.ts",
          before:
            "const ok = await requestApproval(req);\nif (!ok.approved) return deny();",
          after: "return allow();",
        },
      ],
    });
    const hit = r.findings.find((f) => /Approval/.test(f.message));
    expect(hit?.severity).toBe("critical");
    expect(r.status).toBe("fail");
  });

  it("flags removed cancellation handling", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/loop.ts",
          before: "signal?.throwIfCancelled();\nawait work(signal);",
          after: "await work();",
        },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.category === "CONCURRENCY" && /Cancellation/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags removed export as API break", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/api.ts",
          before:
            "export function oldApi(): void {}\nexport function keep(): void {}",
          after: "export function keep(): void {}",
        },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.category === "API_COMPATIBILITY" && /oldApi/.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags source changes with no test changes", () => {
    const r = reviewChange({
      files: [{ path: "src/core.ts", before: "a", after: "b" }],
    });
    expect(r.findings.some((f) => f.category === "TESTING")).toBe(true);
  });

  it("deleted file is reviewed (removed lines scanned)", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/gone.ts",
          before: "try { x(); } catch (e) { y(e); }",
          after: null,
        },
      ],
    });
    expect(r.filesReviewed).toContain("src/gone.ts");
    expect(r.findings.some((f) => f.category === "ERROR_HANDLING")).toBe(true);
  });
});

describe("security analysis", () => {
  it("flags committed secrets as critical", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/cfg.ts",
          before: "",
          after: `export const key = "sk-abc123xyz456789012345";`,
        },
      ],
    });
    const hit = r.findings.find((f) => /secret/i.test(f.message));
    expect(hit?.severity).toBe("critical");
  });

  it("flags .env changes as critical", () => {
    const r = reviewChange({
      files: [{ path: ".env", before: "", after: "DEBUG=true\n" }],
    });
    expect(
      r.findings.some(
        (f) => f.severity === "critical" && /\.env/.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags dynamic shell execution", () => {
    const r = reviewChange({
      files: [
        { path: "src/run.ts", before: "", after: "exec(`git ${userArg}`);" },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.severity === "critical" && /Shell command/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags path traversal construction", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/fs.ts",
          before: "",
          after: "const p = path.join(root, req.params.name);",
        },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.severity === "high" && /traversal/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags live Authorization headers", () => {
    const r = reviewChange({
      files: [
        {
          path: "src/http.ts",
          before: "",
          after: `headers = { Authorization: "Bearer abc123" };`,
        },
      ],
    });
    expect(
      r.findings.some(
        (f) => f.severity === "high" && /Authorization/i.test(f.message),
      ),
    ).toBe(true);
  });
});

describe("test selection", () => {
  const edges = [
    { from: "tests/service.test.ts", to: "src/service.ts" },
    { from: "tests/integration.test.ts", to: "tests/service.test.ts" },
  ];

  it("selects naming counterparts with high confidence", () => {
    const plan = selectTests({
      changedFiles: ["src/service.ts"],
      importEdges: edges,
    });
    expect(plan.targetedTests.map((t) => t.path)).toContain(
      "tests/service.test.ts",
    );
    expect(
      plan.targetedTests.find((t) => t.path === "tests/service.test.ts")!
        .confidence,
    ).toBeGreaterThanOrEqual(0.6);
  });

  it("selects importing tests via graph", () => {
    const plan = selectTests({
      changedFiles: ["src/service.ts"],
      knownTestFiles: ["tests/other.test.ts"],
      importEdges: [{ from: "tests/other.test.ts", to: "src/service.ts" }],
    });
    expect(plan.targetedTests.map((t) => t.path)).toContain(
      "tests/other.test.ts",
    );
  });

  it("changed tests select themselves; integration via 2-hop", () => {
    const plan = selectTests({
      changedFiles: ["tests/service.test.ts"],
      importEdges: edges,
    });
    expect(plan.targetedTests[0]).toMatchObject({
      path: "tests/service.test.ts",
      confidence: 0.9,
    });
    expect(plan.integrationTests.map((t) => t.path)).toContain(
      "tests/integration.test.ts",
    );
  });

  it("recommends full suite when nothing targeted", () => {
    const plan = selectTests({ changedFiles: ["docs/notes.md"] });
    expect(plan.recommendedFullSuite).toBe(true);
    expect(plan.confidence).toBe(0.3);
  });

  it("output is deterministic across runs", () => {
    const a = selectTests({
      changedFiles: ["src/b.ts", "src/a.ts"],
      importEdges: edges,
    });
    const b = selectTests({
      changedFiles: ["src/a.ts", "src/b.ts"],
      importEdges: edges,
    });
    expect(a).toEqual(b);
  });
});

describe("failure classification", () => {
  it("classifies cancellation", () => {
    expect(
      classifyTestFailure({ text: "aborted by user", cancelled: true }).kind,
    ).toBe("CANCELLATION");
  });

  it("classifies timeout (flag and exit 124)", () => {
    expect(classifyTestFailure({ text: "x", timedOut: true }).kind).toBe(
      "TIMEOUT",
    );
    expect(classifyTestFailure({ text: "x", exitCode: 124 }).kind).toBe(
      "TIMEOUT",
    );
  });

  it("classifies environment (missing binary)", () => {
    expect(
      classifyTestFailure({ text: "vitest: command not found", exitCode: 127 })
        .kind,
    ).toBe("ENVIRONMENT");
  });

  it("classifies dependency (missing module)", () => {
    expect(
      classifyTestFailure({ text: "Error: Cannot find module 'foo'" }).kind,
    ).toBe("DEPENDENCY");
  });

  it("classifies configuration", () => {
    expect(
      classifyTestFailure({
        text: "Invalid option '--xyz' in vitest.config.ts",
      }).kind,
    ).toBe("CONFIGURATION");
  });

  it("classifies expected failure markers", () => {
    expect(classifyTestFailure({ text: "test xfail: known issue" }).kind).toBe(
      "EXPECTED_FAILURE",
    );
  });

  it("links assertion failures in changed files to PRODUCTION_REGRESSION", () => {
    const c = classifyTestFailure({
      text: "AssertionError: expected 1 to be 2\n at src/service.ts:10",
      changedFiles: ["src/service.ts"],
    });
    expect(c.kind).toBe("PRODUCTION_REGRESSION");
    expect(c.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("unlinked assertion failures become TEST_FIXTURE, never flaky-by-default", () => {
    const c = classifyTestFailure({
      text: "AssertionError: expected 1 to be 2",
    });
    expect(c.kind).toBe("TEST_FIXTURE");
  });

  it("never labels FLAKY without knownFlaky evidence", () => {
    const c = classifyTestFailure({
      text: "AssertionError: flaky?",
      previousFailures: ["sig1", "sig2"],
    });
    expect(c.kind).not.toBe("FLAKY");
    const withProof = classifyTestFailure({
      text: "AssertionError",
      knownFlaky: true,
      previousFailures: ["sig1"],
    });
    expect(withProof.kind).toBe("FLAKY");
  });

  it("unknown output becomes UNKNOWN with low confidence", () => {
    const c = classifyTestFailure({ text: "all good, nothing to see" });
    expect(c.kind).toBe("UNKNOWN");
    expect(c.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe("risk scoring", () => {
  it("small clean change is LOW", () => {
    expect(
      assessRisk({ filesChanged: ["src/util.ts"], linesAdded: 20 }).level,
    ).toBe("LOW");
  });

  it("auth + gate changes escalate to CRITICAL", () => {
    const r = assessRisk({
      filesChanged: ["src/auth/login.ts", "src/ToolGate.ts", "src/policy.ts"],
      linesAdded: 600,
    });
    expect(r.level).toBe("CRITICAL");
    expect(r.factors.length).toBeGreaterThan(2);
  });

  it("manifest changes add dependency risk", () => {
    const r = assessRisk({ filesChanged: ["package.json"], linesAdded: 5 });
    expect(r.factors.some((f) => /dependency manifest/i.test(f.factor))).toBe(
      true,
    );
  });

  it("tiers are ordered LOW<MEDIUM<HIGH<CRITICAL", () => {
    const low = assessRisk({ filesChanged: ["a.ts"] }).score;
    const med = assessRisk({
      filesChanged: ["a.ts", "b.ts", "c.ts", "d.ts"],
      linesAdded: 150,
    }).score;
    const high = assessRisk({
      filesChanged: ["src/auth/x.ts", "src/db/m.ts"],
      linesAdded: 300,
    }).score;
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });
});

describe("regression detection", () => {
  it("detects removed tests and contract breaks", () => {
    const r = detectRegression({
      beforeTests: ["a.test.ts", "b.test.ts"],
      afterTests: ["a.test.ts"],
      beforeExports: { "api.ts": ["foo", "bar"] },
      afterExports: { "api.ts": ["foo"] },
      filesChanged: ["api.ts"],
    });
    expect(r.removedTests).toEqual(["b.test.ts"]);
    expect(r.contractChanges).toEqual(["api.ts: export removed: bar"]);
  });

  it("flags suspiciously large diffs", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    expect(detectRegression({ filesChanged: files }).largeDiff).toBe(true);
    expect(
      detectRegression({ filesChanged: ["a.ts"], linesAdded: 10 }).largeDiff,
    ).toBe(false);
  });

  it("never claims coverage regression without data", () => {
    expect(detectRegression({ filesChanged: ["a.ts"] }).coverageNote).toMatch(
      /unavailable/,
    );
    const withData = detectRegression({
      filesChanged: ["a.ts"],
      coverageBefore: 80,
      coverageAfter: 75,
    });
    expect(withData.coverageNote).toMatch(/75%/);
  });

  it("lists unrelated modifications only when a related set is given", () => {
    expect(
      detectRegression({ filesChanged: ["a.ts"] }).unrelatedModifications,
    ).toEqual([]);
    const r = detectRegression({
      filesChanged: ["a.ts", "z.ts"],
      relatedFiles: ["a.ts"],
    });
    expect(r.unrelatedModifications).toEqual(["z.ts"]);
  });
});

describe("agent-claim validation (H6 preserved)", () => {
  it("blocks hallucinated completion with zero evidence", () => {
    const v = validateCompletion("Fixed the bug, all tests pass.", {});
    expect(v.verdict).toBe("BLOCKED");
  });

  it("fails claims contradicted by evidence", () => {
    const v = validateCompletion("Fixed the failing test.", {
      filesChanged: ["a.ts"],
      testsRun: ["a.test.ts"],
      testsPassed: false,
    });
    expect(v.verdict).toBe("FAILED");
  });

  it("marks unverified completion INCOMPLETE", () => {
    const v = validateCompletion("Task completed.", {
      filesChanged: ["a.ts"],
      verificationVerdict: "not_verified",
    });
    expect(v.verdict).toBe("INCOMPLETE");
  });

  it("supports evidenced claims and plain prose", () => {
    expect(
      validateCompletion("Fixed login.", {
        filesChanged: ["auth.ts"],
        testsRun: ["auth.test.ts"],
        testsPassed: true,
      }).verdict,
    ).toBe("SUPPORTED");
    expect(validateCompletion("Hello! How can I help?", {}).verdict).toBe(
      "SUPPORTED",
    );
    expect(validateCompletion("", {}).verdict).toBe("INCOMPLETE");
  });
});

describe("verification recommendation (advisory only)", () => {
  it("recommends checks by risk and signals", () => {
    const r = recommendVerification({
      risk: "CRITICAL",
      touchesSecurity: true,
      targetedTestCount: 3,
      manifestChanged: true,
    });
    expect(r.requiredChecks).toEqual(
      expect.arrayContaining(["tests", "typecheck", "build", "security"]),
    );
    expect(r.fullSuiteRecommended).toBe(true);
    expect(r.securityChecks).toContain("secret-scan");
  });

  it("low-risk change gets a minimal set", () => {
    const r = recommendVerification({ risk: "LOW" });
    expect(r.fullSuiteRecommended).toBe(false);
    expect(r.requiredChecks).not.toContain("security");
  });
});

describe("cancellation", () => {
  it("aborts reviewChange mid-scan", () => {
    const c = new AbortController();
    c.abort();
    expect(() =>
      reviewChange({
        files: [{ path: "a.ts", before: "x", after: "y" }],
        signal: c.signal,
      }),
    ).toThrowError(/cancelled/i);
  });

  it("aborts ranking, risk, selection, classification, recommendation, regression", () => {
    const c = new AbortController();
    c.abort();
    expect(() =>
      assessRisk({ filesChanged: ["a.ts"], signal: c.signal }),
    ).toThrow();
    expect(() =>
      selectTests({ changedFiles: ["a.ts"], signal: c.signal }),
    ).toThrow();
    expect(() =>
      classifyTestFailure({ text: "x", signal: c.signal }),
    ).toThrow();
    expect(() =>
      recommendVerification({ risk: "LOW", signal: c.signal }),
    ).toThrow();
    expect(() =>
      detectRegression({ filesChanged: ["a.ts"], signal: c.signal }),
    ).toThrow();
  });
});

describe("performance boundaries", () => {
  it("large diff reviews within bounds", () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `src/f${i}.ts`,
      before: clean(50),
      after: `${clean(50)}\nexport const extra${i} = 1;`,
    }));
    const t = Date.now();
    const r = reviewChange({ files });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.filesReviewed).toHaveLength(30);
  });

  it("oversized file sets are capped with an explicit note", () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      path: `f${i}.ts`,
      before: "a",
      after: "b",
    }));
    const r = reviewChange({ files });
    expect(r.filesReviewed).toHaveLength(100);
    expect(r.recommendations.some((x) => /exceed.*cap/i.test(x))).toBe(true);
  });
});

describe("end-to-end fixture: change → review → tests → failure → recommendation", () => {
  it("full orchestrator-callable chain on an auth change", () => {
    // 1. Changed code: removed guard + dynamic exec in auth service.
    const before = `import { validate } from "./validate";\nexport async function login(token: string): Promise<void> {\n  if (!validate(token)) {\n    throw new Error("bad token");\n  }\n  await startSession(token);\n}\n`;
    const after = `import { exec } from "node:child_process";\nexport async function login(token: string): Promise<void> {\n  exec("audit " + token);\n  await startSession(token);\n}\n`;
    const report = reviewChange({
      task: "Harden login",
      files: [{ path: "src/auth/service.ts", before, after }],
    });
    expect(report.findings.some((f) => f.category === "ERROR_HANDLING")).toBe(
      true,
    );
    expect(
      report.findings.some(
        (f) => f.severity === "critical" && f.category === "SECURITY",
      ),
    ).toBe(true);
    expect(report.risk).not.toBe("LOW");

    // 2. Test selection finds the counterpart.
    const plan = selectTests({
      changedFiles: ["src/auth/service.ts"],
      knownTestFiles: ["tests/auth/service.test.ts"],
      importEdges: [
        { from: "tests/auth/service.test.ts", to: "src/auth/service.ts" },
      ],
    });
    expect(plan.targetedTests.map((t) => t.path)).toContain(
      "tests/auth/service.test.ts",
    );
    expect(plan.confidence).toBeGreaterThan(0.5);

    // 3. Simulated test failure classifies as production regression.
    const failure = classifyTestFailure({
      text: "AssertionError: expected login to reject bad token\n at src/auth/service.ts:4",
      changedFiles: ["src/auth/service.ts"],
    });
    expect(failure.kind).toBe("PRODUCTION_REGRESSION");

    // 4. Verification recommendation requires tests + security.
    const rec = recommendVerification({
      risk: report.risk,
      languagesChanged: ["typescript"],
      hasTests: true,
      targetedTestCount: plan.targetedTests.length,
      touchesSecurity: true,
      failureKind: failure.kind,
    });
    expect(rec.requiredChecks).toEqual(
      expect.arrayContaining(["tests", "security"]),
    );
    expect(rec.reason.length).toBeGreaterThan(0);

    // 5. Agent claim without evidence is blocked (H6 philosophy intact).
    expect(validateCompletion("Fixed login, all tests pass.", {}).verdict).toBe(
      "BLOCKED",
    );
  });
});
