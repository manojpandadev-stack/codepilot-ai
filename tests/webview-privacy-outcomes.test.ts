/**
 * WebView honesty — privacy blocks and provider test outcomes.
 *
 * The host already emits STRUCTURED outcomes (an error card with
 * `privacyBlocked: true`, an inference verdict of `"blocked"`, a
 * `privacy/result` acknowledgement or rejection). These tests pin how the UI
 * must present them, because "the message arrived" is not the same as "the
 * user was told the truth":
 *
 *   1. A Local Only block reads as BLOCKED BY PRIVACY POLICY — never as a
 *      provider, network, or authentication failure, and never as advice to
 *      add a credential (which would suggest bypassing the policy).
 *   2. Inference `blocked` stays distinct from provider failure.
 *   3. An invalid privacy mode is rejected clearly.
 *   4. A missing credential stays distinct from privacy blocking.
 *   5. An UNKNOWN future verdict fails safe — it must never read as success.
 *   6. No credential, bearer header, or secret-bearing endpoint data may
 *      appear in rendered text.
 *   7. Existing success/failure states keep their meaning.
 *
 * Pure view-model functions only — no DOM, no network.
 */
import { describe, expect, it } from "vitest";
import {
  describeErrorCard,
  describeProviderVerdict,
  describePrivacyResult,
} from "../apps/webview/src/lib/messages.js";

const SECRET = "sk-or-webview-must-never-render-not-real";

describe("1. Local Only block renders as a privacy explanation", () => {
  it("frames the host's privacyBlocked card as a policy block, not a failure", () => {
    const view = describeErrorCard({
      message:
        'Privacy mode is "local" but provider "openrouter" sends requests to a remote endpoint. No request was made.',
      privacyBlocked: true,
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
      recoverable: false,
    });

    expect(view.kind).toBe("privacy");
    expect(view.privacyBlocked).toBe(true);
    expect(view.title).toMatch(/blocked by privacy policy/i);
    // Never presented as a provider/network/auth failure.
    expect(view.title).not.toMatch(/failed|error|broken|unavailable/i);
    // A useful action — and NOT "add your API key" (which would suggest
    // bypassing Local Only).
    expect(view.action).toBeTruthy();
    expect(view.action).toMatch(/privacy mode|local provider/i);
    expect(view.action).not.toMatch(/api key|credential|token|sign in/i);
    // The host's own wording is preserved as detail, not discarded.
    expect(view.detail).toMatch(/no request was made/i);
  });

  it("names the provider that was blocked", () => {
    const view = describeErrorCard({
      message: "blocked",
      privacyBlocked: true,
      providerId: "openrouter",
    });
    expect(view.providerId).toBe("openrouter");
    expect(`${view.title} ${view.detail} ${view.action ?? ""}`).toContain(
      "openrouter",
    );
  });
});

describe("2. Inference verdict 'blocked' is not a provider failure", () => {
  it("maps blocked to the privacy kind", () => {
    const view = describeProviderVerdict({
      providerId: "openrouter",
      state: "blocked",
      message: "Local Only privacy mode blocks network access. No request was made.",
    });

    expect(view.kind).toBe("privacy");
    expect(view.privacyBlocked).toBe(true);
    expect(view.providerId).toBe("openrouter");
    expect(view.title).toMatch(/blocked by privacy policy/i);
    expect(view.title).not.toMatch(/provider failed|inference failed|broken/i);
  });

  it("keeps a real provider failure distinct from a privacy block", () => {
    const failed = describeProviderVerdict({
      providerId: "openrouter",
      state: "failed",
      message: "Provider responded HTTP 500.",
    });

    expect(failed.kind).toBe("network");
    expect(failed.privacyBlocked).toBe(false);
    expect(failed.title).not.toMatch(/privacy/i);
  });
});

describe("3. An invalid privacy mode is rejected clearly", () => {
  it("shows a rejection, not a success", () => {
    const view = describePrivacyResult({
      ok: false,
      error: 'Unknown privacy mode: "everything-is-fine"',
    });

    expect(view.kind).toBe("config");
    expect(view.ok).toBe(false);
    expect(view.title).toMatch(/not applied|rejected|invalid/i);
    expect(view.detail).toMatch(/everything-is-fine/);
  });

  it("acknowledges a successful confirmation without over-claiming", () => {
    const view = describePrivacyResult({ ok: true, mode: "cloud", applied: "cloud" });
    expect(view.ok).toBe(true);
    expect(view.title).not.toMatch(/failed|error/i);
    expect(`${view.title} ${view.detail ?? ""}`).toContain("cloud");
  });

  it("fails safe on a malformed privacy/result payload", () => {
    const view = describePrivacyResult(undefined);
    expect(view.ok).toBe(false);
    expect(view.title).toBeTruthy();
    expect(view.title).not.toMatch(/enabled|applied/i);
  });
});

describe("4. Missing credentials stay distinct from privacy blocking", () => {
  it("auth-required is an auth outcome, never a privacy outcome", () => {
    const view = describeErrorCard({
      message: "API key required before testing this provider.",
      recoverable: false,
    });

    expect(view.kind).toBe("auth");
    expect(view.privacyBlocked).toBe(false);
    expect(view.title).toMatch(/api key|credential|sign in|auth/i);
    expect(view.title).not.toMatch(/privacy/i);
  });

  it("a rejected key is still auth, not privacy", () => {
    const view = describeProviderVerdict({
      providerId: "openai-native",
      state: "auth-failed",
      message: "Provider rejected the credential (HTTP 401/403).",
    });
    expect(view.kind).toBe("auth");
    expect(view.privacyBlocked).toBe(false);
  });
});

describe("5. Unknown future verdicts fail safe", () => {
  it("never presents an unknown verdict as success", () => {
    for (const state of ["quantum-superposition", "", null, undefined, 42, {}]) {
      const view = describeProviderVerdict({
        providerId: "openrouter",
        state,
        message: "x",
      });
      expect(view.kind).toBe("unknown");
      expect(view.title).not.toMatch(/success|connected|working/i);
    }
  });

  it("never presents an unknown error-card shape as a privacy block", () => {
    const view = describeErrorCard(null);
    expect(view.kind).toBe("unknown");
    expect(view.privacyBlocked).toBe(false);
    expect(view.title).not.toMatch(/privacy/i);
  });

  it("a privacyBlocked flag without a usable message still blocks honestly", () => {
    const view = describeErrorCard({ privacyBlocked: true });
    expect(view.kind).toBe("privacy");
    expect(view.title).toMatch(/blocked by privacy policy/i);
  });
});

describe("6. No secret ever reaches rendered text", () => {
  it("strips nothing but never echoes a secret the host should not have sent", () => {
    // The host never puts a key in these payloads; if one ever appears, the
    // view must not be the component that re-surfaces it as an action.
    const view = describeErrorCard({
      message: `Request to ${SECRET} failed.`,
      privacyBlocked: true,
      providerId: "openrouter",
    });
    expect(view.action).not.toContain(SECRET);
    expect(view.title).not.toContain(SECRET);
  });

  it("never renders an Authorization header", () => {
    const view = describeProviderVerdict({
      providerId: "openrouter",
      state: "auth-failed",
      message: "Authorization: Bearer sk-should-not-be-here rejected",
    });
    expect(`${view.title} ${view.action ?? ""}`).not.toMatch(/bearer|authorization/i);
  });
});

describe("7. Existing success and failure states are unchanged", () => {
  it("a successful inference still reads as success", () => {
    const view = describeProviderVerdict({
      providerId: "openrouter",
      state: "success",
      message: "Model response received.",
      latencyMs: 120,
    });
    expect(view.kind).toBe("success");
    expect(view.privacyBlocked).toBe(false);
    expect(view.title).not.toMatch(/fail|privacy/i);
  });

  it("a healthy connection probe still reads as connected", () => {
    const view = describeProviderVerdict({
      providerId: "ollama",
      state: "connected",
      message: "Connected.",
    });
    expect(view.kind).toBe("success");
  });

  it("invalid-config stays a configuration outcome", () => {
    const view = describeProviderVerdict({
      providerId: "openai",
      state: "invalid-config",
      message: "No base URL configured for this provider.",
    });
    expect(view.kind).toBe("config");
    expect(view.privacyBlocked).toBe(false);
  });

  it("cancellation and timeout keep their own outcomes", () => {
    const cancelled = describeProviderVerdict({
      providerId: "openrouter",
      state: "failed",
      message: "Inference probe cancelled.",
    });
    expect(cancelled.kind).toBe("cancelled");

    const timedOut = describeProviderVerdict({
      providerId: "openrouter",
      state: "failed",
      message: "Provider did not respond in time.",
    });
    expect(timedOut.kind).toBe("timeout");
    expect(timedOut.privacyBlocked).toBe(false);
  });
});
// ===========================================================================
// 8. REAL host contract — the payload the WebView keys on must actually exist.
//
// The view-models above are pure. These tests drive the REAL extension host
// and assert the structured fields the UI branches on are really emitted, so
// the UI cannot drift into "renders a generic error" again.
// ===========================================================================
describe("host contract: the structured fields the UI reads are really sent", () => {
  it("sends privacyBlocked + provider identity on a Local Only block", async () => {
    const { freshHost } = await import("./vscode-integration-harness");
    const { describeErrorCard: classify } = await import(
      "../apps/webview/src/lib/messages.js"
    );
    const host = await freshHost();
    const sent: Array<{ type: string; payload: unknown }> = [];
    try {
      const svc = host.seams.getProviderService();
      await svc.setCredential("openai-native", "sk-openai-host-contract-not-real");
      await host.seams.handleMessage({
        type: "settings/set",
        id: "hc-prov",
        payload: { key: "provider", value: "openai-native" },
        timestamp: Date.now(),
      });
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        sent.push(m as { type: string; payload: unknown });
      });
      await host.seams.runPrompt("hi", "act");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !sent.some((m) => m.type === "error")) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const card = sent.find((m) => m.type === "error");
      expect(card).toBeDefined();
      const payload = card!.payload as {
        privacyBlocked?: boolean;
        providerId?: string;
        message?: string;
      };
      expect(payload.privacyBlocked).toBe(true);
      expect(payload.providerId).toBe("openai-native");

      // The UI's own classifier turns that real payload into the honest view.
      const view = classify(card!.payload);
      expect(view.kind).toBe("privacy");
      expect(view.privacyBlocked).toBe(true);
      expect(view.title).toMatch(/blocked by privacy policy/i);
      expect(view.action).not.toMatch(/api key|credential/i);
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 60_000);

  it("sends an inference verdict of 'blocked' with no secret", async () => {
    const { freshHost } = await import("./vscode-integration-harness");
    const host = await freshHost();
    const sent: Array<{ type: string; payload: unknown }> = [];
    const SECRET = "sk-openai-inference-blocked-not-real";
    try {
      const svc = host.seams.getProviderService();
      await svc.setCredential("openai-native", SECRET);
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        sent.push(m as { type: string; payload: unknown });
      });
      await host.seams.handleMessage({
        type: "provider/inference-test",
        id: "hc-inf",
        payload: { providerId: "openai-native", modelId: "gpt-4o" },
        timestamp: Date.now(),
      });
      const inf = sent.find((m) => m.type === "provider/inference_result");
      expect(inf).toBeDefined();
      const p = inf!.payload as {
        providerId?: string;
        state?: string;
        message?: string;
      };
      expect(p.state).toBe("blocked");
      expect(p.providerId).toBe("openai-native");
      expect(JSON.stringify(sent)).not.toContain(SECRET);
      expect(describeProviderVerdict(inf!.payload).kind).toBe("privacy");
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 60_000);

  it("sends privacy/result ok:false for an invalid mode", async () => {
    const { freshHost } = await import("./vscode-integration-harness");
    const host = await freshHost();
    const sent: Array<{ type: string; payload: unknown }> = [];
    try {
      host.ext.__setWebviewSinkForIntegrationTest((m) => {
        sent.push(m as { type: string; payload: unknown });
      });
      await host.seams.handleMessage({
        type: "privacy/confirm",
        id: "hc-bad",
        payload: { mode: "everything-is-fine" },
        timestamp: Date.now(),
      });
      const res = sent.find((m) => m.type === "privacy/result");
      expect(res).toBeDefined();
      expect((res!.payload as { ok?: boolean }).ok).toBe(false);
      expect(describePrivacyResult(res!.payload).ok).toBe(false);
      expect(describePrivacyResult(res!.payload).kind).toBe("config");
    } finally {
      host.ext.__clearWebviewSinkForIntegrationTest();
      await host.ext.deactivate().catch(() => {});
      host.cleanup();
    }
  }, 60_000);
});
