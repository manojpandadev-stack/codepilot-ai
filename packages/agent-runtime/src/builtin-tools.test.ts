/**
 * Unit tests for the run_commands streaming integration.
 *
 * The VS Code runtime injects the M7 streaming shell executor as
 * `streamingCommandRunner`, so run_commands shares the ONE streaming
 * terminal path with `bash` instead of completion-only collection. These
 * tests prove the tool-level contract with a mock runner (the streaming
 * executor itself has its own tests; the live E2E proves the real pipe).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createCodePilotBuiltinTools, CODEPILOT_MODEL_TOOL_NAMES } from "./builtin-tools.js";
import {
  CommandExecutionService,
  persistToolOutput,
  getOutputSidecarDir,
} from "@codepilot/tool-engine";

describe("run_commands streaming integration", () => {
  it("routes commands through the injected streaming runner with toolCallId and signal", async () => {
    const runner = vi.fn(
      async (input: { command: string }) => `out:${input.command}`,
    );
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      streamingCommandRunner: runner,
    });
    const tool = tools.find((t) => t.name === "run_commands");
    expect(tool).toBeDefined();

    const controller = new AbortController();
    const result = await tool!.execute(
      { command: "echo FIRST" },
      { toolCallId: "call-1", signal: controller.signal },
    );
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0]).toMatchObject({
      command: "echo FIRST",
      toolCallId: "call-1",
      signal: controller.signal,
    });
    expect(String(result)).toContain("$ echo FIRST");
    expect(String(result)).toContain("out:echo FIRST");
  });

  it("runs batched commands sequentially through the runner and joins them", async () => {
    const seen: string[] = [];
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      streamingCommandRunner: async (input) => {
        seen.push(input.command);
        return `result-for-${input.command}`;
      },
    });
    const tool = tools.find((t) => t.name === "run_commands")!;
    const result = await tool.execute(
      { commands: ["cmd-one", "cmd-two"] },
      { toolCallId: "call-2" },
    );
    expect(seen).toEqual(["cmd-one", "cmd-two"]);
    const text = String(result);
    expect(text.indexOf("result-for-cmd-one")).toBeGreaterThan(-1);
    expect(text.indexOf("result-for-cmd-two")).toBeGreaterThan(
      text.indexOf("result-for-cmd-one"),
    );
  });

  it("propagates runner failures so dispatch maps them to tool errors", async () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
      streamingCommandRunner: async () => {
        throw new Error("[Command exited with code 3]\nboom");
      },
    });
    const tool = tools.find((t) => t.name === "run_commands")!;
    await expect(
      tool.execute({ command: "failing" }, { toolCallId: "call-3" }),
    ).rejects.toThrow(/exited with code 3/);
  });

  it(
    "falls back to completion-oriented collection when no runner is injected (headless)",
    { timeout: 20_000 },
    async () => {
      // Real CommandExecutionService — proves the headless path still executes
      // a real process through service.run with unchanged (raw-spawn)
      // semantics: the whole string is the executable, args empty. `hostname`
      // is a single token that exits immediately on Windows and POSIX.
      const tools = createCodePilotBuiltinTools({
        cwd: process.cwd(),
        enableBash: false,
      });
      const tool = tools.find((t) => t.name === "run_commands")!;
      const result = await tool.execute({ command: "hostname" }, {});
      const text = String(result);
      expect(text).toContain("$ hostname");
      expect(text).not.toContain("timed out");
      expect(text).not.toContain("Command cancelled");
    },
  );

  it("the runtime-facing factory keeps bash/run_commands in the model tool names", () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("run_commands");
    expect(CommandExecutionService).toBeDefined();
  });
});


// ---------------------------------------------------------------- plan tool
describe("plan tool (structured execution plan)", () => {
  interface PlanEvent {
    kind: "created" | "updated";
    plan: import("./task-plan.js").TaskPlan;
  }

  function planHarness() {
    const events: PlanEvent[] = [];
    let held: import("./task-plan.js").TaskPlan | null = null;
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      planBridge: {
        getPlan: () => held,
        onChange: (plan, kind) => {
          held = plan;
          events.push({ kind, plan });
        },
      },
    });
    const plan = tools.find((t) => t.name === "plan");
    expect(plan, "plan tool missing from the canonical tool set").toBeDefined();
    return { events, getHeld: () => held, planTool: plan! };
  }

  it("create validates, reports progress, and notifies the bridge once", async () => {
    const { events, getHeld, planTool } = planHarness();
    const raw = await planTool.execute(
      {
        action: "create",
        objective: "  Ship the release  ",
        steps: [
          { title: "Write tests", affected_files: ["src/a.ts"] },
          { title: "Run suite", depends_on: ["step-1"] },
        ],
      },
      { toolCallId: "tc-plan-1" },
    );
    const out = JSON.parse(String(raw));
    expect(out).toMatchObject({
      ok: true,
      created: true,
      progress: { total: 2, completed: 0, failed: 0, running: 0, pending: 2 },
    });
    expect(out.steps).toEqual([
      { id: "step-1", title: "Write tests" },
      { id: "step-2", title: "Run suite" },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("created");
    expect(events[0]!.plan.objective).toBe("Ship the release");
    expect(events[0]!.plan.steps[0]!.affectedFiles).toEqual(["src/a.ts"]);
    expect(events[0]!.plan.steps[1]!.dependsOn).toEqual(["step-1"]);
    expect(getHeld()?.id).toBe(out.planId);
  });

  it("update moves a step through running → completed and re-notifies", async () => {
    const { events, planTool } = planHarness();
    await planTool.execute(
      {
        action: "create",
        objective: "Two steps",
        steps: [{ title: "one" }, { title: "two" }],
      },
      { toolCallId: "tc-plan-2a" },
    );
    const running = JSON.parse(
      String(
        await planTool.execute(
          { action: "update", step_number: 1, status: "running" },
          { toolCallId: "tc-plan-2b" },
        ),
      ),
    );
    expect(running).toMatchObject({
      ok: true,
      step: { id: "step-1", status: "running" },
      progress: { completed: 0, running: 1, pending: 1 },
    });
    const done = JSON.parse(
      String(
        await planTool.execute(
          { action: "update", step_id: "step-1", status: "completed", note: "green" },
          { toolCallId: "tc-plan-2c" },
        ),
      ),
    );
    expect(done.step.status).toBe("completed");
    expect(done.progress).toMatchObject({ completed: 1, running: 0, pending: 1 });
    expect(events.map((e) => e.kind)).toEqual(["created", "updated", "updated"]);
    expect(events[2]!.plan.steps[0]!.note).toBe("green");
  });

  it("update without a plan is a structured error the model can correct", async () => {
    const { planTool } = planHarness();
    await expect(
      planTool.execute(
        { action: "update", step_number: 1, status: "running" },
        { toolCallId: "tc-plan-3" },
      ),
    ).rejects.toThrow(/No plan exists yet/);
  });

  it("unknown action and invalid transitions are hard errors", async () => {
    const { planTool } = planHarness();
    await expect(
      planTool.execute({ action: "delete" }, { toolCallId: "tc-plan-4a" }),
    ).rejects.toThrow(/action=create\|action=update/);
    await planTool.execute(
      { action: "create", objective: "one step", steps: [{ title: "only" }] },
      { toolCallId: "tc-plan-4b" },
    );
    await planTool.execute(
      { action: "update", step_number: 1, status: "running" },
      { toolCallId: "tc-plan-4c" },
    );
    await planTool.execute(
      { action: "update", step_number: 1, status: "completed" },
      { toolCallId: "tc-plan-4d" },
    );
    await expect(
      planTool.execute(
        { action: "update", step_number: 1, status: "pending" },
        { toolCallId: "tc-plan-4e" },
      ),
    ).rejects.toThrow(/illegal transition for step-1: completed → pending/);
    await expect(
      planTool.execute(
        { action: "update", step_number: 1, status: "nonsense" },
        { toolCallId: "tc-plan-4f" },
      ),
    ).rejects.toThrow(/must be one of/);
  });
});


// ------------------------------------- inspect_symbols (Phase 4 parity)
describe("inspect_symbols (structural map, Phase 4)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-inspect-"));
    dirs.push(dir);
    return dir;
  }

  function inspectTool(cwd: string) {
    const tool = createCodePilotBuiltinTools({ cwd, enableBash: false }).find(
      (t) => t.name === "inspect_symbols",
    );
    expect(tool, "inspect_symbols missing from the always-on factory").toBeDefined();
    return tool!;
  }

  it("is advertised by the always-on factory with a read-only contract", () => {
    const tools = createCodePilotBuiltinTools({
      cwd: process.cwd(),
      enableBash: false,
    });
    const tool = tools.find((t) => t.name === "inspect_symbols")!;
    expect(tool.description).toMatch(/read-only/i);
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toContain("path");
    expect(schema.required).toContain("path");
  });

  it("returns a structured outline for a real TS file", async () => {
    const cwd = makeWorkspace();
    fs.writeFileSync(
      path.join(cwd, "sample.ts"),
      [
        "export class Widget {",
        '  label = "}";',
        "}",
        "export const make = () => new Widget();",
      ].join("\n"),
    );
    const result = (await inspectTool(cwd).execute(
      { path: "sample.ts" },
      { toolCallId: "inspect-1" },
    )) as Record<string, unknown>;
    expect(result.path).toBe("sample.ts");
    expect(result.language).toBe("typescript");
    expect(result.supported).toBe(true);
    expect(result.totalLines).toBe(4);
    expect(result.note).toBeUndefined();
    const symbols = result.symbols as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(
      symbols.map((s) => [s.name as string, s]),
    );
    expect(byName.Widget).toMatchObject({ line: 1, endLine: 3 });
    expect(byName.make).toMatchObject({ line: 4, endLine: 4 });
  });

  it("reports unsupported files honestly with a read_files follow-up hint", async () => {
    const cwd = makeWorkspace();
    fs.writeFileSync(path.join(cwd, "main.rs"), "fn main() {}");
    const result = (await inspectTool(cwd).execute(
      { path: "main.rs" },
      { toolCallId: "inspect-2" },
    )) as Record<string, unknown>;
    expect(result.supported).toBe(false);
    expect(result.language).toBe("rust");
    expect(result.symbols).toEqual([]);
    expect(result.symbolCount).toBe(0);
    expect(String(result.note)).toContain("read_files");
  });

  it("caps symbols via max_symbols while reporting the full count", async () => {
    const cwd = makeWorkspace();
    const lines: string[] = [];
    for (let i = 0; i < 5; i += 1) lines.push(`export const c${i} = ${i};`);
    fs.writeFileSync(path.join(cwd, "many.ts"), lines.join("\n"));
    const result = (await inspectTool(cwd).execute(
      { path: "many.ts", max_symbols: 2 },
      { toolCallId: "inspect-3" },
    )) as Record<string, unknown>;
    expect((result.symbols as unknown[]).length).toBe(2);
    expect(result.symbolCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("rejects workspace escapes, absolute paths, binaries, and bad input", async () => {
    const cwd = makeWorkspace();
    const tool = inspectTool(cwd);
    await expect(
      tool.execute({ path: "../outside.ts" }, { toolCallId: "inspect-4" }),
    ).rejects.toThrow();
    await expect(
      tool.execute({ path: path.join(cwd, "abs.ts") }, { toolCallId: "inspect-5" }),
    ).rejects.toThrow();
    fs.writeFileSync(
      path.join(cwd, "bin.ts"),
      Buffer.from([0x00, 0x01, 0x02]),
    );
    await expect(
      tool.execute({ path: "bin.ts" }, { toolCallId: "inspect-6" }),
    ).rejects.toThrow(/binary/);
    await expect(
      tool.execute({ path: "missing.ts" }, { toolCallId: "inspect-7" }),
    ).rejects.toThrow(/missing/);
    await expect(
      tool.execute({}, { toolCallId: "inspect-8" }),
    ).rejects.toThrow(/requires \{ path \}/);
  });
});


// ------------------------------------- read-only git tools (Phase 5)
describe("git tools (read-only, model-callable)", () => {
  const dirs: string[] = [];
  const gitBin = process.env.CODEPILOT_TEST_GIT ?? "git";
  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function git(dir: string, ...args: string[]): string {
    return execFileSync(gitBin, args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-git-"));
    dirs.push(dir);
    git(dir, "init");
    git(dir, "config", "user.email", "test@codepilot.local");
    git(dir, "config", "user.name", "CodePilot Test");
    git(dir, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(dir, "README.md"), "baseline\n");
    git(dir, "add", "README.md");
    git(dir, "-c", "commit.gpgsign=false", "commit", "-m", "init");
    return dir;
  }

  function toolFor(cwd: string, name: string) {
    const tool = createCodePilotBuiltinTools({ cwd, enableBash: false }).find(
      (t) => t.name === name,
    );
    expect(tool, `${name} missing from the always-on factory`).toBeDefined();
    return tool!;
  }

  it("git_status reports branch and untracked files", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "hello.txt"), "hi\n");
    const result = (await toolFor(dir, "git_status").execute(
      {},
      { toolCallId: "git-1" },
    )) as Record<string, unknown>;
    expect(String(result.output)).toContain("## ");
    expect(String(result.output)).toContain("hello.txt");
  });

  it("git_diff scopes staged vs working tree and to a path", async () => {
    const dir = makeRepo();
    fs.appendFileSync(path.join(dir, "README.md"), "CHANGED-LINE\n");
    const working = (await toolFor(dir, "git_diff").execute(
      {},
      { toolCallId: "git-2" },
    )) as Record<string, unknown>;
    expect(String(working.output)).toContain("CHANGED-LINE");

    const scoped = (await toolFor(dir, "git_diff").execute(
      { path: "README.md" },
      { toolCallId: "git-5" },
    )) as Record<string, unknown>;
    expect(String(scoped.output)).toContain("CHANGED-LINE");

    git(dir, "add", "README.md");
    const afterStage = (await toolFor(dir, "git_diff").execute(
      {},
      { toolCallId: "git-3" },
    )) as Record<string, unknown>;
    expect(String(afterStage.output)).toBe("");

    const staged = (await toolFor(dir, "git_diff").execute(
      { staged: true },
      { toolCallId: "git-4" },
    )) as Record<string, unknown>;
    expect(String(staged.output)).toContain("CHANGED-LINE");

    const stagedScoped = (await toolFor(dir, "git_diff").execute(
      { staged: true, path: "README.md" },
      { toolCallId: "git-12" },
    )) as Record<string, unknown>;
    expect(String(stagedScoped.output)).toContain("CHANGED-LINE");

    await expect(
      toolFor(dir, "git_diff").execute({ path: "-x" }, { toolCallId: "git-6" }),
    ).rejects.toThrow(/leading '-'/);
  });

  it("git_log bounds count and git_show validates refs", async () => {
    const dir = makeRepo();
    const log = (await toolFor(dir, "git_log").execute(
      { count: 5 },
      { toolCallId: "git-7" },
    )) as Record<string, unknown>;
    expect(String(log.output)).toContain("init");

    const show = (await toolFor(dir, "git_show").execute(
      { ref: "HEAD" },
      { toolCallId: "git-8" },
    )) as Record<string, unknown>;
    expect(String(show.output)).toContain("init");

    await expect(
      toolFor(dir, "git_show").execute({ ref: "-x" }, { toolCallId: "git-9" }),
    ).rejects.toThrow(/rejected/);
    await expect(
      toolFor(dir, "git_show").execute(
        { ref: "a b" },
        { toolCallId: "git-10" },
      ),
    ).rejects.toThrow(/rejected/);
    await expect(
      toolFor(dir, "git_show").execute({}, { toolCallId: "git-11" }),
    ).rejects.toThrow(/requires \{ ref \}/);
  });

  it("all git tools fail structured outside a repository (no crash)", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-nogit-"));
    dirs.push(bare);
    for (const name of ["git_status", "git_diff", "git_log", "git_show"]) {
      const input = name === "git_show" ? { ref: "HEAD" } : {};
      await expect(
        toolFor(bare, name).execute(input, { toolCallId: `git-${name}` }),
      ).rejects.toThrow(/not a git repository/);
    }
  });
});


// ------------------------------------ read_tool_output sidecar (Phase 7b)
describe("read_tool_output builtin", () => {
  const cleanupFiles: string[] = [];
  afterEach(() => {
    while (cleanupFiles.length > 0) {
      try {
        fs.rmSync(cleanupFiles.pop()!, { force: true });
      } catch {
        // best-effort
      }
    }
  });
  function trackRef(ref: string): string {
    cleanupFiles.push(path.join(getOutputSidecarDir(), `${ref}.txt`));
    return ref;
  }
  function tool() {
    const tools = createCodePilotBuiltinTools({ cwd: process.cwd() });
    const found = tools.find((t) => t.name === "read_tool_output");
    expect(found, "read_tool_output missing from factory").toBeDefined();
    return found!;
  }

  it("returns the persisted full output verbatim", async () => {
    const ref = trackRef(persistToolOutput("line1\nline2\nline3")!);
    expect(await tool().execute({ ref })).toBe("line1\nline2\nline3");
  });

  it("slices with offset/max_chars and reports the exact range", async () => {
    const text = `${"A".repeat(100)}MIDDLEMARKER${"B".repeat(100)}`;
    const ref = trackRef(persistToolOutput(text)!);
    const out = (await tool().execute({
      ref,
      offset: 100,
      max_chars: 12,
    })) as string;
    expect(out).toContain("MIDDLEMARKER");
    expect(out).toContain(
      `[read_tool_output: chars 100-112 of ${text.length} total]`,
    );
    expect(out).not.toContain("AAAA");
  });

  it("rejects malformed refs, expired refs, and missing input", async () => {
    await expect(tool().execute({ ref: "../etc/passwd" })).rejects.toThrow(
      /invalid ref/,
    );
    await expect(
      tool().execute({ ref: "out_deadbeefdeadbeef" }),
    ).rejects.toThrow(/not found or expired/);
    await expect(tool().execute({})).rejects.toThrow(/requires \{ ref \}/);
  });

  it("is advertised in the canonical model tool name list", () => {
    expect(CODEPILOT_MODEL_TOOL_NAMES).toContain("read_tool_output");
  });
});


// ------------------------------- search_codebase behavioral (row 9)
describe("search_codebase behavioral", () => {
  it("finds regex matches across workspace files and ignores dependency dirs", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-search-"));
    try {
      fs.mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "src", "a.ts"),
        "const TOKEN = 'alpha-marker';\nconsole.log(TOKEN);\n",
      );
      fs.writeFileSync(
        path.join(ws, "node_modules", "dep", "b.js"),
        "const TOKEN = 'alpha-marker';\n",
      );
      fs.writeFileSync(path.join(ws, "README.md"), "nothing here\n");
      const tools = createCodePilotBuiltinTools({ cwd: ws });
      const tool = tools.find((t) => t.name === "search_codebase")!;
      const out = (await tool.execute({ query: "alpha-marker" })) as Array<{
        query: string;
        path?: string;
        text?: string;
        matches?: number;
      }>;
      const hit = out.find((r) => r.path?.includes("a.ts"));
      expect(hit?.text).toContain("alpha-marker");
      expect(out.some((r) => r.path?.includes("node_modules"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("supports the queries array form (up to 10 patterns)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-search-"));
    try {
      fs.writeFileSync(path.join(ws, "one.txt"), "needle-one\n");
      fs.writeFileSync(path.join(ws, "two.txt"), "needle-two\n");
      const tools = createCodePilotBuiltinTools({ cwd: ws });
      const tool = tools.find((t) => t.name === "search_codebase")!;
      const out = (await tool.execute({
        queries: ["needle-one", "needle-two"],
      })) as Array<{ query: string; path?: string }>;
      expect(out.find((r) => r.query === "needle-one")?.path).toBe("one.txt");
      expect(out.find((r) => r.query === "needle-two")?.path).toBe("two.txt");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects invalid regex with a structured error", async () => {
    const tools = createCodePilotBuiltinTools({ cwd: process.cwd() });
    const tool = tools.find((t) => t.name === "search_codebase")!;
    await expect(tool.execute({ query: "([" })).rejects.toThrow(
      /invalid regex/,
    );
    await expect(tool.execute({})).rejects.toThrow(/requires \{ query \}/);
  });
});
