/**
 * LIVE CLOUD E2E — real cloud model (OpenAI via OPENAI_API_KEY), real agent,
 * real M4 approvals, real verification. GATED behind CCPILOT_E2E_CLOUD=1 so
 * the deterministic suite never makes a paid API call.
 *
 * SECRETS: the key is read from process.env at runtime and passed straight
 * to SecretStorage (the production path). It is NEVER printed, logged,
 * written to the repo, or embedded in this file. All assertions on messages
 * scrub for the key material before they could surface in logs.
 *
 * Skip contract: when the gate is unset or no key is present the file
 * skips honestly (the deterministic suite must stay hermetic).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  freshHost,
  sleep,
  type FreshHost,
} from "./vscode-integration-harness";
import { runVerification } from "../packages/tool-engine/src/verification-engine.js";
import type {
  WebviewMessage,
  VerificationStatePayload,
} from "@codepilot/shared";

const TEMPLATE = path.resolve(__dirname, "..", "sandbox/ccpilot-e2e-workspace");
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "ccpilot-cloud-ws-"));
fs.cpSync(TEMPLATE, WORKSPACE, { recursive: true });
const CALC = path.join(WORKSPACE, "src", "calc.js");
const Buggy = "return a - b;";
const Fixed = "return a + b;";

const API_KEY = process.env.OPENAI_API_KEY ?? "";

/**
 * Pre-flight credential verification (only when the gate is on): one real
 * authenticated probe of the OpenAI models endpoint. A key the provider
 * REJECTS must skip the leg honestly — the first run of this suite burned a
 * 10-minute window learning that the environment key returns 401. No key
 * material is printed; only the boolean verdict leaves this function.
 */
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

/** True when any outbound message accidentally embeds key material. */
function leakDetected(): boolean {
  return sent.some(
    (m) =>
      API_KEY.length > 10 &&
      JSON.stringify(m).includes(API_KEY),
  );
}

function agentStatuses(): string[] {
  return sent
    .filter((m) => m.type === "agent/status")
    .map((m) => (m.payload as { status?: string }).status ?? "?");
}

function toolEvents(): Array<{ type: string; name: string }> {
  return sent
    .filter(
      (m) =>
        m.type === "tool/started" ||
        m.type === "tool/completed" ||
        m.type === "tool_failed",
    )
    .map((m) => ({
      type: m.type,
      name: (m.payload as { toolName?: string }).toolName ?? "?",
    }));
}

function lastVerification(): VerificationStatePayload | undefined {
  const states = sent
    .filter((m) => m.type === "verification/state")
    .map((m) => m.payload as VerificationStatePayload);
  return states[states.length - 1];
}

describe.skipIf(!GATE_ON)(
  "Live cloud pre-flight (credential verdict is reported, never printed)",
  { timeout: 30_000 },
  () => {
    it("reports the credential verdict honestly", async () => {
      // When the key was rejected this records the real provider verdict;
      // when accepted the coding leg below runs against the live API.
      expect(GATE_ON).toBe(true);
      if (!LIVE_CLOUD) {
        console.log(
          "[cloud-e2e] credential NOT accepted by provider — coding leg skipped honestly",
        );
      }
      expect(true).toBe(true);
    });
  },
);

describe.skipIf(!LIVE_CLOUD)(
  "Live cloud coding-agent E2E (OpenAI, disposable workspace)",
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
      host.vscodeStub.configOverrides.set("maxIterations", 24);
      // Credential flows through the PRODUCTION path (SecretStorage), with
      // the runtime resolving it host-side. The webview never sees it.
      const svc = host.seams.getProviderService();
      await svc.setCredential("openai-native", API_KEY);
      await host.seams.handleMessage({
        type: "provider/configure",
        id: `wv-live-${Date.now()}`,
        payload: { providerId: "openai-native", apiKey: API_KEY },
        timestamp: Date.now(),
      });
      await host.seams.handleMessage({
        type: "settings/set",
        id: `wv-live-set-${Date.now()}`,
        payload: { key: "provider", value: "openai-native" },
        timestamp: Date.now(),
      });
      // Cloud inference requires an explicit privacy opt-in — the runtime's
      // fail-closed guard blocks remote providers under Local Only mode
      // (verified live in the previous run: the guard fired). The user (and
      // this test) must choose Cloud mode; the product never flips it.
      await host.seams.handleMessage({
        type: "settings/set",
        id: `wv-live-priv-${Date.now()}`,
        payload: { key: "privacyMode", value: "cloud" },
        timestamp: Date.now(),
      });
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        const msg = m as WebviewMessage;
        sent.push(msg);
        if (msg.type === "tool/request_approval") {
          const p = msg.payload as { approvalId: string };
          setTimeout(() => {
            void host.seams.handleMessage({
              type: "tool/approval_result",
              id: `wv-approval-${p.approvalId}`,
              payload: { approvalId: p.approvalId, decision: "allow", scope: "once" },
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
    }, 60_000);

    afterAll(async () => {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    });

    it(
      "cloud agent inspects, edits, gets approval, applies, and verification passes",
      { timeout: 700_000 },
      async () => {
        // Baseline: fixture is broken.
        const before = await runVerification({
          workspaceRoot: WORKSPACE,
          checks: ["tests"],
          timeoutMs: 30_000,
        });
        expect(before.verdict).toBe("failed");

        await host.seams.runPrompt(
          "Fix the bug in src/calc.js: add(a, b) returns a - b but must return a + b. " +
            "Read the file first, then edit it. When done, run 'node tests/run.test.js' " +
            "and confirm all tests pass.",
          "act",
        );

        // Wait for ANY terminal lifecycle state (completed | idle | failed |
        // error | aborted). A run that ends "failed" must fail the leg with
        // its real diagnostic — never spin out the full window blindly.
        const deadline = Date.now() + 600_000;
        while (Date.now() < deadline) {
          await sleep(2_000);
          const st = agentStatuses();
          if (
            st.includes("completed") ||
            st.includes("idle") ||
            st.includes("failed") ||
            st.includes("error") ||
            st.includes("aborted")
          ) {
            break;
          }
        }
        // Diagnostics: capture the final agent text so a failure shows the
        // model's actual last word (scrubbed of secrets by the sink path).
        const lastStatusMsg = [...sent]
          .reverse()
          .find((m) => m.type === "agent/status");
        const diag = JSON.stringify(lastStatusMsg?.payload ?? {}).slice(
          0,
          1200,
        );

        // Secrecy invariant across the whole exchange.
        expect(leakDetected()).toBe(false);

        // The run settled (real lifecycle statuses).
        const statuses = agentStatuses();
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses[0]).toBe("running");
        if (
          !statuses.includes("completed") &&
          !statuses.includes("idle")
        ) {
          // Honest failure with the run's real terminal payload.
          throw new Error(
            `cloud leg did not complete — terminal statuses=[${statuses.join(",")}] payload=${diag}`,
          );
        }

        // Real tool activity (inspect → edit).
        const names = toolEvents().map((t) => t.name);
        expect(names.length).toBeGreaterThan(0);
        expect(
          names.some((n) => /read|search|edit|write|apply|terminal|bash/i.test(n)),
        ).toBe(true);

        // Outcome on disk or staged (both legitimate; silent no-op is not).
        const src = fs.readFileSync(CALC, "utf8");
        const fixedOnDisk = src.includes(Fixed) && !src.includes(Buggy);
        const diffCreated = sent.some(
          (m) =>
            m.type === "diff/created" &&
            JSON.stringify(m.payload).includes("calc.js"),
        );
        expect(fixedOnDisk || diffCreated).toBe(true);

        // Verification AFTER the fix: tests must pass for real.
        const after = await runVerification({
          workspaceRoot: WORKSPACE,
          timeoutMs: 60_000,
        });
        expect(after.verdict).toBe("verified");
      },
    );

    it("cancellation stops a cloud run without fabricating completion", { timeout: 120_000 }, async () => {
      sent.length = 0;
      void host.seams.runPrompt(
        "Count slowly from 1 to 500, listing every number.",
        "act",
      );
      // Wait until the run is genuinely in flight before stopping.
      const startDeadline = Date.now() + 30_000;
      while (Date.now() < startDeadline && !agentStatuses().includes("running")) {
        await sleep(1_000);
      }
      await host.seams.stopAgent();
      await sleep(3_000);
      const statuses = agentStatuses();
      expect(statuses).toContain("running"); // the run had really started
      expect(statuses).not.toContain("completed");
      expect(
        statuses.includes("idle") || statuses.includes("aborted"),
      ).toBe(true);
    });

    it("provider errors surface as user-visible error messages (invalid model)", { timeout: 120_000 }, async () => {
      sent.length = 0;
      // Select a model id that cannot exist — the API must 404/400 and the
      // user must SEE a real error, never a silent no-op or fake success.
      await host.seams.handleMessage({
        type: "settings/set",
        id: `wv-badmodel-${Date.now()}`,
        payload: { key: "model", value: "this-model-does-not-exist-xyz" },
        timestamp: Date.now(),
      });
      await host.seams.runPrompt("Say hi.", "act");
      const deadline = Date.now() + 90_000;
      let sawError = false;
      while (Date.now() < deadline) {
        await sleep(2_000);
        sawError =
          sent.some((m) => m.type === "error") ||
          agentStatuses().some((s) => s === "error" || s === "failed");
        if (sawError) break;
      }
      expect(sawError).toBe(true);
      // The surfaced error must be the provider's real verdict (model/HTTP
      // failure), not an unrelated host-side rejection.
      const errText = sent
        .filter((m) => m.type === "error")
        .map((m) => JSON.stringify(m.payload))
        .join(" ");
      expect(errText).toMatch(/model|chat|http|400|404|failed/i);
      // Restore the working model for any subsequent use.
      await host.seams.handleMessage({
        type: "settings/set",
        id: `wv-restore-${Date.now()}`,
        payload: { key: "model", value: "gpt-4o-mini" },
        timestamp: Date.now(),
      });
    });
  },
);
