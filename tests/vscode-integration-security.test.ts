/**
 * Integration security validation (Phase 7).
 *
 * Drives synthetic (clearly fake, uniquely marked) secrets through the REAL
 * extension pipeline — tool inputs, tool outputs, assistant text, failure
 * errors, terminal errors, and a live M4 evaluation — then sweeps EVERY byte
 * under the isolated storage dir (task JSON + audit JSONL) asserting no
 * marker survives. Markers are fake by construction; they exist only to
 * prove absence. Nothing here is printed.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  freshHost,
  scriptedRun,
  expectValidJsonl,
} from "./vscode-integration-harness";
import { TaskStore } from "../packages/agent-runtime/src/m12-task-store";

// Synthetic markers — fake values shaped like real credential formats.
const BEARER = "Bearer INT-BEARER-9f8e7d6c5b4a";
const OPENAI_KEY = "sk-int-FAKEFAKEFAKEFAKE00";
const GITHUB_TOKEN = "ghp_intFAKEFAKEFAKEFAKE12";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "INTFAKEKEYMATERIAL",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const URL_WITH_CREDS =
  "https://intuser:intpass@example.com/x?api_key=INT-QUERY-SECRET-1";
const CMD_SECRET = "deploy --token=INT-CMD-SECRET-2";
const ENV_SECRET_1 = "INT-ENV-SECRET-3";
const ENV_SECRET_2 = "INT-ENV-SECRET-4";
const ERR_BEARER = "Bearer INT-ERR-BEARER-5";
const TERMINAL_KEY = "sk-int-ERR-FAKEFAKEFAKEFAKE";

const MARKERS = [
  "INT-BEARER-9f8e7d6c5b4a",
  "sk-int-FAKEFAKEFAKEFAKE00",
  "ghp_intFAKEFAKEFAKEFAKE12",
  "INTFAKEKEYMATERIAL",
  "intpass",
  "INT-QUERY-SECRET-1",
  "INT-CMD-SECRET-2",
  ENV_SECRET_1,
  ENV_SECRET_2,
  "INT-ERR-BEARER-5",
  "sk-int-ERR-FAKEFAKEFAKEFAKE",
];

/** Every file's raw bytes under dir, recursively. */
function sweepBytes(dir: string): Array<{ file: string; raw: string }> {
  const out: Array<{ file: string; raw: string }> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ file: p, raw: fs.readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

describe("integration security — no secret survives on disk", () => {
  it("tool inputs/outputs/text/errors/audit are all scrubbed", async () => {
    const host = await freshHost();
    try {
      // Live M4 evaluation with a secret-laced filename: the audit trail
      // must keep the filename shape but never the token value. (Write/
      // execute tools would block on webview approval with no UI attached;
      // read tools auto-approve through the real policy — same sink path.)
      const bridge = host.seams.getLivePermissionBridge();
      const m4 = await bridge.evaluateLiveTool({
        toolName: "read_file",
        input: { path: `/tmp/report-${GITHUB_TOKEN}.txt` },
        taskId: "sec-task",
      });
      // Approved or denied by policy either way, the decision is recorded
      // through the real sink — the sweep below proves the token is absent.
      expect(typeof m4.approved).toBe("boolean");

      const taskId = await scriptedRun(host, {
        title: "security sweep",
        deltas: [`analysis done, saw ${OPENAI_KEY} in output`],
        tools: [
          {
            id: "sec-1",
            name: "bash",
            input: {
              command: `curl -H 'Authorization: ${BEARER}' ${URL_WITH_CREDS} && ${CMD_SECRET}`,
              apiKey: ENV_SECRET_1,
              nested: { password: ENV_SECRET_2 },
            },
            output: `token ${GITHUB_TOKEN} leaked\n${PEM}\nend`,
          },
          {
            id: "sec-2",
            name: "bash",
            input: { command: "will fail" },
            output: "",
            fail: true,
            error: `fetch failed: ${ERR_BEARER}`,
          },
        ],
        terminal: "error",
        resultText: `provider failed with ${TERMINAL_KEY}`,
      });

      await host.ext.deactivate();
      expectValidJsonl(host.auditFile);

      // The run itself stayed fully usable (redaction never broke shape).
      const task = await new TaskStore(host.tasksDir).get(taskId);
      expect(task).not.toBeNull();

      // Sweep every persisted byte.
      const files = sweepBytes(host.storageDir);
      expect(files.length).toBeGreaterThan(0);
      for (const marker of MARKERS) {
        for (const { file, raw } of files) {
          expect(
            raw.includes(marker),
            `marker#${MARKERS.indexOf(marker)} leaked into ${path.basename(file)}`,
          ).toBe(false);
        }
      }
      // Redaction visibly engaged (defense-in-depth signal, not a secret).
      const taskRaw = fs.readFileSync(
        path.join(host.tasksDir, `${taskId}.json`),
        "utf8",
      );
      expect(taskRaw).toContain("[REDACTED]");
      const auditRaw = fs.readFileSync(host.auditFile, "utf8");
      // M4 safeTarget kept the filename shape, dropped the token value.
      expect(auditRaw).toContain("report-");
    } finally {
      host.cleanup();
    }
  });
});
