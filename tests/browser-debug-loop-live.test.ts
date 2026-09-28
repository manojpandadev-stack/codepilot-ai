/**
 * PHASE 6 — BROWSER AUTONOMOUS DEBUG LOOP (live) + SSRF prelude.
 *
 * Deterministic prelude (no model, no Ollama): with PRODUCTION defaults,
 * BrowserService.navigate refuses a loopback URL BEFORE any browser process
 * is launched — the security posture the previous audit relied on, now
 * pinned as a regression test.
 *
 * Live loop (real qwen3:8b through the production pipeline): a disposable
 * app with TWO deliberate defects —
 *   DEFECT A (logic): the page renders "5 + 5 = 11" instead of 10
 *   DEFECT B (visual): a 9999px-wide container overflows the viewport
 * The model is told ONLY how to start the app and what "works" means; it
 * must start it (terminal), open it (browser_navigate), interact
 * (browser_click), read evidence (browser_extract/console/network),
 * diagnose from project files (read_files), stage fixes (editor → M4 →
 * ChangeSet), and retest until the page shows 10.
 *
 * The FINAL VERDICT is deterministic and independent of model prose: the
 * fixed file is re-served by a fresh server instance and the response body
 * is asserted. No SSRF production default is weakened — the loop runs under
 * the explicit TEST-ONLY override (codepilot.localAI.browser.allowLoopback-

 * ForTests), which keeps cloud-metadata endpoints blocked in all cases.
 *
 * Skips honestly (logged) when no local Ollama is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserService } from "../packages/browser-engine/src/index.js";
import { discoverBrowserChannel } from "../apps/vscode-extension/src/browser-service.js";
import type { FreshHost } from "./vscode-integration-harness";

const OLLAMA_URL = "http://127.0.0.1:11434";
const LEG_TIMEOUT = 3_600_000;

interface CapturedMessage {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}
const ofType = (m: CapturedMessage[], t: string) => m.filter((x) => x.type === t);

let live = false;
let root = "";
let storageDir = "";
let host: FreshHost;
let messages: CapturedMessage[] = [];

/** Same disclosed CPU/latency controls as the capability-audit suite. */
function setLiveConfigOverrides() {
  host.vscodeStub.configOverrides.set("model", "qwen3:8b");
  host.vscodeStub.configOverrides.set("maxIterations", 24);
  host.vscodeStub.configOverrides.set("localAI.ollama.useNodeHttpTransport", true);
  host.vscodeStub.configOverrides.set("localAI.ollama.think", "disabled");
  host.vscodeStub.configOverrides.set("localAI.ollama.keepAlive", 60);
}

async function makeHost(workspaceRoot: string, storage: string): Promise<FreshHost> {
  const { vi } = await import("vitest");
  vi.resetModules();
  const vscodeStub = await import("vscode");
  vscodeStub.workspace.workspaceFolders.length = 0;
  vscodeStub.workspace.workspaceFolders.push({ uri: { fsPath: workspaceRoot } });
  const ext = await import("../apps/vscode-extension/src/extension");
  const context = {
    secrets: new vscodeStub.SecretStorageStub(),
    globalState: new vscodeStub.MementoStub(),
    workspaceState: new vscodeStub.MementoStub(),
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: storage,
    extensionUri: vscodeStub.Uri.file(storage),
    globalStoragePath: storage,
    globalStorageUri: vscodeStub.Uri.file(storage),
    extensionMode: 1,
  };
  ext.activate(context as unknown as Parameters<typeof ext.activate>[0]);
  ext.__setWebviewSinkForIntegrationTest((m) => messages.push(m as CapturedMessage));
  return {
    ext,
    seams: ext.__integrationSeams,
    vscodeStub,
    storageDir: storage,
    tasksDir: path.join(storage, "tasks"),
    auditDir: path.join(storage, "audit"),
    auditFile: path.join(storage, "audit", "tool-audit.jsonl"),
    cleanup: () => fs.rmSync(storage, { recursive: true, force: true }),
  } as unknown as FreshHost;
}

interface LegResult {
  leg: string;
  toolNames: string[];
  toolOutputs: string[];
  approvals: number;
  final: string;
  elapsedMs: number;
  streamDeltas: number;
}

/** One chat/send leg; approvals auto-answered per policy. */
async function leg(
  legName: string,
  prompt: string,
  mode: "act" | "ask" | "plan",
  policy: "allow-all" | "deny-all" = "allow-all",
): Promise<LegResult> {
  const started = Date.now();
  messages.length = 0;
  const answered: string[] = [];
  const run = host.seams.handleMessage({
    type: "chat/send",
    id: `p6-${legName}`,
    payload: { text: prompt, mode, requestId: `p6-${legName}` },
    timestamp: Date.now(),
  } as never);
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  let lastHeartbeat = Date.now();
  let lastEventCount = -1;
  while (!settled) {
    await new Promise((r) => setTimeout(r, 500));
    // Liveness heartbeat: every 5 min of silence, log whether ANY event is
    // arriving (a fully eventless leg means the model transport is hung, not
    // that the model is quietly working).
    if (Date.now() - lastHeartbeat > 300_000) {
      lastHeartbeat = Date.now();
      if (messages.length === lastEventCount) {
        console.log(
          `P6 HEARTBEAT: no new events for 5min (total=${messages.length}) — model transport may be hung`,
        );
      }
      lastEventCount = messages.length;
    }
    for (const m of ofType(messages, "tool/request_approval")) {
      const id = String(m.payload?.approvalId ?? m.id ?? "");
      if (!id || answered.includes(id)) continue;
      answered.push(id);
      await host.seams.handleMessage({
        type: "tool/approval_result",
        id: `ans-${id}`,
        payload: { approvalId: id, decision: policy === "allow-all" ? "allow" : "deny" },
        timestamp: Date.now(),
      } as never);
    }
  }
  // Surface any error/failure events the runtime emitted.
  const errors = messages
    .filter((m) => /error|failed/i.test(m.type))
    .map((m) => `${m.type}: ${JSON.stringify(m.payload ?? {}).slice(0, 300)}`);
  if (errors.length) console.log("P6 RUNTIME ERRORS:", JSON.stringify(errors, null, 2));
  const toolNames = ofType(messages, "tool/started").map((m) => String(m.payload?.toolName ?? ""));
  const streamCount = ofType(messages, "chat/stream_delta").length;
  const toolOutputs = ofType(messages, "tool/completed").map(
    (m) => `${m.payload?.toolName}: ${String(m.payload?.output ?? "").slice(0, 400)}`,
  );
  const final = ofType(messages, "chat/stream_delta")
    .map((m) => String(m.payload?.accumulated ?? ""))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const res: LegResult = {
    leg: legName,
    toolNames,
    toolOutputs,
    approvals: answered.length,
    final: final.slice(0, 800),
    elapsedMs: Date.now() - started,
    streamDeltas: streamCount,
  };
  console.log("P6 EVIDENCE:", JSON.stringify(res, null, 2));
  return res;
}

/**
 * Deterministic app check (NOT the model verdict): start a fresh server
 * instance for the workspace, fetch the page, kill the server. Asserts the
 * real served bytes before and after the model's fix.
 */
async function startAppAndFetch(ws: string): Promise<{ ok: boolean; body: string }> {
  const { spawn } = await import("child_process");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ws,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app did not report a port")), 10_000);
    let buf = "";
    const tryResolve = () => {
      const m = /PORT=(\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    };
    child.stdout?.on("data", (d) => {
      buf += String(d);
      tryResolve();
    });
    child.on("exit", (c) => {
      // The daemonizing launcher exits 0 right after printing PORT=<n> —
      // only an exit WITHOUT a port is a failure.
      if (!/PORT=(\d+)/.exec(buf)) {
        clearTimeout(t);
        reject(new Error(`app exited early (${c})`));
      }
    });
    child.on("error", (e) => { clearTimeout(t); reject(e); });
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
    return { ok: r.ok, body: await r.text() };
  } finally {
    child.kill();
  }
}

beforeAll(async () => {
  live = await (async () => {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return r.ok;
    } catch {
      return false;
    }
  })();
  if (!live) {
    console.log("SKIP browser-debug-loop live legs: no Ollama at", OLLAMA_URL);
    return;
  }
  // Warm the model into memory BEFORE the leg. A cold disk load inside the
  // first model call has previously combined with a busy shared server into
  // multi-hour eventless stalls. Disclosed CPU control.
  try {
    const warm = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3:8b",
        prompt: "ping",
        stream: false,
        options: { num_predict: 1 },
        keep_alive: "60m",
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!warm.ok) {
      live = false;
      console.log("SKIP P6: model warmup failed with HTTP", warm.status);
      return;
    }
    console.log("P6 WARMUP: qwen3:8b resident in memory");
  } catch (e) {
    live = false;
    console.log("SKIP P6: model warmup failed:", String(e).slice(0, 120));
    return;
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-debug-live-"));
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-debug-storage-"));
}, 330_000);

afterAll(async () => {
  if (!live) return;
  // Kill the daemonized fixture server (best-effort) — pid recorded by the
  // app itself in server.port ('<port> <pid>').
  try {
    if (root) {
      const pf = path.join(root, "browser-debug-test", "server.port");
      if (fs.existsSync(pf)) {
        const pid = Number(fs.readFileSync(pf, "utf8").trim().split(/\s+/)[1]);
        if (Number.isFinite(pid) && pid > 0) process.kill(pid);
      }
    }
  } catch {
    // already gone
  }
  if (!host) return;
  host.vscodeStub.configOverrides.delete("model");
  host.vscodeStub.configOverrides.delete("maxIterations");
  host.ext.__clearWebviewSinkForIntegrationTest();
  await host.ext.deactivate().catch(() => {});
  host.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// Deterministic prelude — production SSRF default (no model required)
// ===========================================================================

describe("P6 prelude — production SSRF default blocks the local app", () => {
  it("BrowserService.navigate refuses loopback before any page navigation", async () => {
    const channel = discoverBrowserChannel();
    if (!channel) {
      // No system browser: the production pipeline would not even expose
      // browser tools. Assert the same policy the navigate path consults.
      const { validateTargetUrl } = await import("../packages/browser-engine/src/index.js");
      expect((await validateTargetUrl("http://127.0.0.1:9/app", {})).verdict).toBe(
        "blocked-private-network",
      );
      console.log("P6 prelude: no system browser — asserted at validateTargetUrl level");
      return;
    }
    const svc = new BrowserService({ channel });
    try {
      const res = await svc.navigate("p6-task", "p6-session", "http://127.0.0.1:9/app");
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/navigation blocked/);
      // The page was NEVER navigated: no goto, no HTTP request to loopback.
      // (The lazy browser process may have started for the session, but the
      // blocked URL never reaches Chromium.)
    } finally {
      await svc.dispose();
    }
  });

  it("TEST-ONLY override permits loopback navigation (policy mechanism)", async () => {
    const channel = discoverBrowserChannel();
    if (!channel) {
      console.log("P6 prelude: no system browser — skipping override mechanism probe");
      return;
    }
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p id=probe>OVERRIDE-OK</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    const svc = new BrowserService({
      channel,
      urlPolicy: { allowPrivateNetworks: true },
    });
    try {
      const res = await svc.navigate(
        "p6-override-task",
        "p6-override-session",
        `http://127.0.0.1:${addr.port}/`,
      );
      expect(res.ok).toBe(true);
      const snap = await svc.inspect("p6-override-task", "p6-override-session");
      expect(JSON.stringify(snap)).toContain("OVERRIDE-OK");
      console.log("P6 OVERRIDE EVIDENCE: loopback navigation + inspection succeeded under the explicit override");
    } finally {
      await svc.dispose();
      server.close();
    }
  });
});

// ===========================================================================
// Live autonomous debug loop under the TEST-ONLY override
// ===========================================================================

describe("P6 — autonomous browser debug loop (live qwen3:8b)", () => {
  it(
    "two-defect app: start → navigate → interact → evidence → fix → retest → page shows 10",
    { timeout: LEG_TIMEOUT },
    async () => {
      if (!live) return;

      // ---- Disposable two-defect app (quote-free HTML attrs on purpose) ---
      // server.js daemonizes itself: the launcher invocation prints PORT=<n>
      // and EXITS while the detached daemon keeps listening — otherwise the
      // tracked terminal's exec timeout (61s) kills the foreground server
      // before the model ever navigates (measured in live attempt 3).
      const ws = path.join(root, "browser-debug-test");
      fs.mkdirSync(path.join(ws, "public"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, "server.js"),
        [
          "const http = require('http');",
          "const fs = require('fs');",
          "const path = require('path');",
          "const PORT_FILE = path.join(__dirname, 'server.port');",
          "if (!process.env.APP_DAEMON) {",
          "  try {",
          "    const prev = fs.readFileSync(PORT_FILE, 'utf8').trim().split(/\\s+/);",
          "    if (prev[1]) process.kill(Number(prev[1]));",
          "  } catch (e) { /* no previous daemon or already gone */ }",
          "  const { spawn } = require('child_process');",
          "  const child = spawn(process.execPath, [__filename], {",
          "    env: { ...process.env, APP_DAEMON: '1' },",
          "    detached: true,",
          "    stdio: 'ignore',",
          "  });",
          "  child.unref();",
          "  const t0 = Date.now();",
          "  const timer = setInterval(() => {",
          "    if (fs.existsSync(PORT_FILE)) {",
          "      clearInterval(timer);",
          "      console.log('PORT=' + fs.readFileSync(PORT_FILE, 'utf8').split(String.fromCharCode(10))[0]);",
          "      process.exit(0);",
          "    }",
          "    if (Date.now() - t0 > 10000) { clearInterval(timer); console.error('server did not start'); process.exit(1); }",
          "  }, 100);",
          "  return;",
          "}",
          "const server = http.createServer((req, res) => {",
          "  if (req.url === '/api/sum') {",
          "    res.writeHead(200, { 'Content-Type': 'application/json' });",
          "    res.end(JSON.stringify({ sum: 10 }));",
          "    return;",
          "  }",
          "  res.writeHead(200, { 'Content-Type': 'text/html' });",
          "  res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));",
          "});",
          "server.listen(0, '127.0.0.1', () => {",
          "  fs.writeFileSync(PORT_FILE, server.address().port + ' ' + process.pid);",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      // DEFECT A: renders 11 instead of 10. DEFECT B: 9999px overflow.
      // The /api/sum endpoint returns the CORRECT 10 — the page ignores it
      // and renders a hard-coded wrong literal, so console/network evidence
      // alone is not enough; the model must read the served markup.
      fs.writeFileSync(
        path.join(ws, "public", "index.html"),
        [
          "<html><body>",
          "<div style=width:9999px>",
          "<h1>Calculator</h1>",
          "<button id=calc onclick=fetch('/api/sum').then(r=>r.json()).then(d=>{document.getElementById('out').textContent='5 + 5 = 11'})>Calculate</button>",
          "<p id=out>not calculated</p>",
          "</div>",
          "</body></html>",
          "",
        ].join("\n"),
        "utf8",
      );

      // Deterministic fixture baseline: the app serves and is wrong. The
      // baseline daemon stays tracked in server.port so the model's own
      // start reaps it (the server reaps via the port file on every launch).
      const before = await startAppAndFetch(ws);
      expect(before.ok).toBe(true);
      expect(before.body).toContain("5 + 5 = 11");

      // ---- Host on the app workspace, TEST-ONLY loopback override ON ------
      host = await makeHost(ws, storageDir);
      setLiveConfigOverrides();
      host.vscodeStub.configOverrides.set("localAI.browser.allowLoopbackForTests", true);
      await host.seams.ensureRuntime();

      const r = await leg(
        "p6-debug-loop",
        "A tiny web app is provided in this workspace: server.js serves public/index.html and a JSON endpoint /api/sum. Start it with `node server.js` (it prints a line PORT=<number> when listening). Then use the browser tools to open http://localhost:<port>/, click the Calculate button, and verify the page shows exactly 10. If it does not, use the browser inspection tools and the project files to find the cause, fix it, and retest in the browser until the page shows 10. Do not stop until the page shows 10.",
        "act",
      );

      // ---- Autonomous-loop evidence (real tools through the pipeline) -----
      const names = r.toolNames;
      console.log("P6 TOOL SEQUENCE:", JSON.stringify(names));
      expect(names.some((n) => n === "terminal_session_start" || n === "terminal_session_exec" || n === "bash" || n === "run_commands")).toBe(true);
      expect(names).toContain("browser_navigate");
      expect(names).toContain("browser_click");
      expect(names.some((n) => n === "browser_extract" || n === "browser_console" || n === "browser_network")).toBe(true);
      // Real M4 approvals were requested and granted for protected ops.
      expect(r.approvals).toBeGreaterThan(0);

      // ---- Accept staged fixes through the REAL webview path --------------
      const csIds = [...new Set(ofType(messages, "diff/created").map((m) => String(m.payload?.changeSetId ?? "")))];
      console.log("P6 CHANGESETS:", JSON.stringify(csIds));
      for (const csId of csIds) {
        messages.length = 0;
        await host.seams.handleMessage({
          type: "diff/accept_all",
          id: `p6-accept-${csId}`,
          payload: { changeSetId: csId },
          timestamp: Date.now(),
        } as never);
      }

      // ---- Deterministic final verdict on real served bytes ---------------
      const html = fs.readFileSync(path.join(ws, "public", "index.html"), "utf8");
      expect(html).not.toContain("= 11");
      const after = await startAppAndFetch(ws);
      expect(after.ok).toBe(true);
      expect(after.body).toMatch(/5 \+ 5 = 10/);
    },
    LEG_TIMEOUT,
  );
});
