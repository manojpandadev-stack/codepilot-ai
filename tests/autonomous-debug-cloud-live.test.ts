/**
 * PHASE 12 — LIVE CLOUD autonomous-debugging E2E (opt-in, paid API).
 *
 * Runs CodePilot's autonomous recovery engine against a DISPOSABLE copy of
 * the buggy fixture (`sandbox/ccpilot-e2e-workspace`: add() returns a - b
 * while the test expects add(2, 2) === 4) using the existing configured
 * cloud provider. No Ollama. Never prints or logs key material.
 *
 * Flow exercised end to end through the REAL host:
 *   failing test (real output) → FAILURE_DETECTED → diagnosis (plan-mode
 *   agent session, read-only) → REPAIR_PROPOSED → REPAIR_APPROVAL_REQUIRED
 *   (modal; this test plays the user) → REPAIR_APPLIED (act-mode session,
 *   every tool call through M4, writes staged as ChangeSets) → targeted +
 *   broad verification (real commands) → RECOVERY_COMPLETED(SUCCESS) with
 *   evidence, plus the file fixed on disk.
 *
 * Gating mirrors `provider-cloud-e2e-live.test.ts`: CCPILOT_E2E_CLOUD=1 AND
 * an OpenAI key the provider actually accepts. Without the gate the file
 * skips honestly and the deterministic suite stays hermetic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freshHost, sleep, type FreshHost } from "./vscode-integration-harness";
import { runVerification } from "../packages/tool-engine/src/verification-engine.js";
import type { WebviewMessage } from "@codepilot/shared";

const TEMPLATE = path.resolve(__dirname, "..", "sandbox/ccpilot-e2e-workspace");
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ccpilot-autodbg-ws-"));
fs.cpSync(TEMPLATE, WORKSPACE, { recursive: true });
const CALC = path.join(WORKSPACE, "src", "calc.js");

const API_KEY = process.env.OPENAI_API_KEY ?? "";

/** One real authenticated probe — rejected credentials skip the leg honestly. */
async function credentialAccepted(): Promise<boolean> {
  if (API_KEY.length <= 10) return false;
  try {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

const GATE_ON = process.env.CCPILOT_E2E_CLOUD === "1" && API_KEY.length > 10;
const LIVE_CLOUD = GATE_ON && (await credentialAccepted());

let host: FreshHost;
const sent: WebviewMessage[] = [];
/** Repair approval prompts presented to the "user" (this test). */
const approvalPrompts: string[] = [];
let originalShowWarningMessage:
  ((...args: unknown[]) => Promise<unknown>) | undefined;

const recoveryPhases = (): string[] =>
  sent
    .filter((m) => m.type === "recovery/event")
    .map((m) => String((m.payload as { phase?: string }).phase ?? "?"));

const recoveryStatuses = (): string[] =>
  sent
    .filter((m) => m.type === "recovery/event")
    .map((m) => String((m.payload as { status?: string }).status ?? ""))
    .filter((s) => s.length > 0);

/** True when any outbound message accidentally embeds key material. */
function leakDetected(): boolean {
  return (
    API_KEY.length > 10 && sent.some((m) => JSON.stringify(m).includes(API_KEY))
  );
}

describe.skipIf(!LIVE_CLOUD)(
  "Live cloud autonomous debugging E2E (disposable workspace)",
  { timeout: 900_000 },
  () => {
    beforeAll(async () => {
      host = await freshHost();
      host.vscodeStub.workspace.workspaceFolders.length = 0;
      host.vscodeStub.workspace.workspaceFolders.push({
        uri: { fsPath: WORKSPACE },
      });
      host.vscodeStub.configOverrides.set("provider", "openai-native");
      host.vscodeStub.configOverrides.set("model", "gpt-4o-mini");
      host.vscodeStub.configOverrides.set("maxIterations", 30);

      const svc = host.seams.getProviderService();
      await svc.setCredential("openai-native", API_KEY);
      await host.seams.handleMessage({
        type: "provider/configure",
        id: `wv-adbg-${Date.now()}`,
        payload: { providerId: "openai-native", apiKey: API_KEY },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "settings/set",
        id: `wv-adbg-priv-${Date.now()}`,
        payload: { key: "privacyMode", value: "cloud" },
        timestamp: Date.now(),
      });

      // This test plays the USER: auto-approve M4 tool requests and staged
      // ChangeSets, and approve the controller's repair proposal modal.
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        const msg = m as WebviewMessage;
        sent.push(msg);
        if (msg.type === "tool/request_approval") {
          const p = msg.payload as { approvalId: string };
          setTimeout(() => {
            void host.seams.handleMessage({
              type: "tool/approval_result",
              id: `wv-approval-${p.approvalId}`,
              payload: {
                approvalId: p.approvalId,
                decision: "allow",
                scope: "once",
              },
              timestamp: Date.now(),
            });
          }, 25);
        }
        if (msg.type === "diff/created") {
          const p = msg.payload as { changeSetId: string };
          setTimeout(() => {
            void host.seams.handleMessage({
              type: "diff/accept_all",
              id: `wv-accept-${p.changeSetId}`,
              payload: { changeSetId: p.changeSetId },
              timestamp: Date.now(),
            });
          }, 60);
        }
      });

      // Repair-approval modal: the test acts as the user pressing
      // "Apply repair" (the extension's fail-closed default is deny).
      // MUST patch host.vscodeStub — freshHost() resets the module registry,
      // so this instance is the exact `vscode` the extension resolved.
      const win = host.vscodeStub.window as unknown as {
        showWarningMessage: (...args: unknown[]) => Promise<unknown>;
      };
      originalShowWarningMessage = win.showWarningMessage;
      win.showWarningMessage = async (...args: unknown[]) => {
        approvalPrompts.push(String(args[0] ?? "").slice(0, 3_000));
        const items = (args.slice(2) as string[]).filter(
          (i) => typeof i === "string",
        );
        return items[0];
      };
    }, 120_000);

    afterAll(async () => {
      if (originalShowWarningMessage) {
        const win = host.vscodeStub.window as unknown as {
          showWarningMessage: (...args: unknown[]) => Promise<unknown>;
        };
        win.showWarningMessage = originalShowWarningMessage;
      }
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
      fs.rmSync(WORKSPACE, { recursive: true, force: true });
    });

    it(
      "diagnoses → approves → applies → verifies the real bug to SUCCESS",
      { timeout: 800_000 },
      async () => {
        // Baseline: the fixture is genuinely broken (real command output).
        const baseline = await runVerification({
          workspaceRoot: WORKSPACE,
          checks: ["tests"],
          timeoutMs: 60_000,
        });
        expect(baseline.verdict).toBe("failed");
        expect(fs.readFileSync(CALC, "utf8")).toContain("return a - b;");

        // Real failing output seeds the diagnostic context.
        const failingRun = await runVerification({
          workspaceRoot: WORKSPACE,
          checks: ["tests"],
          timeoutMs: 60_000,
        });
        const failingCheck = failingRun.checks.find(
          (c) => c.status === "failed",
        );

        await host.seams.handleMessage({
          type: "agent/heal",
          id: `wv-heal-${Date.now()}`,
          payload: {
            exitCode: failingCheck?.exitCode ?? 1,
            stderr:
              failingCheck?.error ??
              "AssertionError: expected -0 to be 4 (add(2, 2))",
            diagnostics: [],
            validateCommand: "node tests/run.test.js",
          },
          timestamp: Date.now(),
        });

        // Wait for the recovery controller to settle (bounded, honest).
        const deadline = Date.now() + 700_000;
        while (Date.now() < deadline) {
          await sleep(3_000);
          const phases = recoveryPhases();
          if (
            phases.includes("RECOVERY_COMPLETED") ||
            phases.includes("RECOVERY_EXHAUSTED")
          ) {
            break;
          }
        }

        // Secrecy invariant across the whole exchange.
        expect(leakDetected()).toBe(false);

        const phases = recoveryPhases();
        const diag = `phases=[${phases.join(",")}] statuses=[${recoveryStatuses().join(",")}] prompts=${approvalPrompts.length}`;

        // The canonical recovery timeline was surfaced to the UI.
        expect(phases).toContain("FAILURE_DETECTED");
        expect(phases).toContain("DIAGNOSIS_STARTED");
        expect(phases).toContain("REPAIR_PROPOSED");
        expect(phases).toContain("REPAIR_APPROVAL_REQUIRED");

        // The approval prompt showed action, files, risk, and preview.
        expect(approvalPrompts.length).toBeGreaterThanOrEqual(1);
        const prompt = approvalPrompts[0]!;
        expect(prompt).toContain("Proposed action:");
        expect(prompt).toContain("Affected files:");
        expect(prompt).toContain("Risk level:");
        expect(prompt).toContain("M4");

        // Verification really ran (targeted at minimum).
        expect(phases).toContain("VERIFICATION_STARTED");

        const statuses = recoveryStatuses();
        expect(
          statuses.includes("SUCCESS"),
          `recovery did not reach SUCCESS — ${diag}`,
        ).toBe(true);
        expect(phases).toContain("RECOVERY_COMPLETED");
        expect(phases).not.toContain("RECOVERY_EXHAUSTED");

        // Final evidence: the fix is on disk and the real suite passes.
        const src = fs.readFileSync(CALC, "utf8");
        expect(src).toContain("return a + b;");
        expect(src).not.toContain("return a - b;");
        const after = await runVerification({
          workspaceRoot: WORKSPACE,
          timeoutMs: 120_000,
        });
        expect(after.verdict).toBe("verified");
      },
    );
  },
);
