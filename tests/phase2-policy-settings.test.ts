import { describe, it, expect } from "vitest";
import { DEFAULT_TOOL_POLICIES, isAllowedSettingKey, ALLOWED_SETTINGS_KEYS } from "../packages/shared/src/index.js";
import { PolicyEngine } from "../packages/policy-engine/src/index.js";

// ============================================================================
// Policy alignment (native callable tool names must map)
// ============================================================================

describe("DEFAULT_TOOL_POLICIES align with native callable tool names", () => {
  it("gates real write tools behind approval", () => {
    expect(DEFAULT_TOOL_POLICIES.editor).toBe("approval");
    expect(DEFAULT_TOOL_POLICIES.apply_patch).toBe("approval");
    expect(DEFAULT_TOOL_POLICIES.create_file).toBe("approval");
  });

  it("gates real execute and network tools behind approval", () => {
    expect(DEFAULT_TOOL_POLICIES.run_commands).toBe("approval");
    expect(DEFAULT_TOOL_POLICIES.bash).toBe("approval");
    expect(DEFAULT_TOOL_POLICIES.fetch_web_content).toBe("approval");
  });

  it("keeps read tools auto-approved", () => {
    expect(DEFAULT_TOOL_POLICIES.read_files).toBe("auto");
    expect(DEFAULT_TOOL_POLICIES.search_codebase).toBe("auto");
    expect(DEFAULT_TOOL_POLICIES.read_file).toBe("auto");
  });
});

describe("PolicyEngine enforces mode + tool gating", () => {
  it("blocks editor in plan mode", () => {
    const engine = new PolicyEngine({ initialMode: "plan" });
    const policy = engine.checkPermission("editor", { file_path: "x.ts", new_string: "y" });
    expect(policy.enabled).toBe(false);
    expect(policy.autoApprove).toBe(false);
  });

  it("allows read_files in plan mode without approval", () => {
    const engine = new PolicyEngine({ initialMode: "plan" });
    const policy = engine.checkPermission("read_files", { file_path: "x.ts" });
    expect(policy.enabled).toBe(true);
    expect(policy.autoApprove).toBe(true);
  });

  it("requires approval for run_commands in act mode", () => {
    const engine = new PolicyEngine({ initialMode: "act" });
    const policy = engine.checkPermission("run_commands", { command: "npm test" });
    expect(policy.enabled).toBe(true);
    expect(policy.autoApprove).toBe(false);
  });

  it("blocks dangerous commands even when the tool is allowed", () => {
    const engine = new PolicyEngine({ initialMode: "act" });
    const policy = engine.checkPermission("run_commands", { command: "rm -rf /" });
    expect(policy.enabled).toBe(false);
  });
});

// ============================================================================
// Settings allowlist (Feature Group 20 — never write unregistered config keys)
// ============================================================================

describe("isAllowedSettingKey", () => {
  it("accepts every registered configuration key", () => {
    for (const key of ALLOWED_SETTINGS_KEYS) {
      expect(isAllowedSettingKey(key), key).toBe(true);
      expect(isAllowedSettingKey(`codepilot.${key}`), `codepilot.${key}`).toBe(true);
    }
  });

  it("rejects arbitrary or unknown keys", () => {
    expect(isAllowedSettingKey("model")).toBe(true); // real key
    expect(isAllowedSettingKey("unknownSetting")).toBe(false);
    expect(isAllowedSettingKey("apiKey")).toBe(false);
    expect(isAllowedSettingKey("secret")).toBe(false);
    expect(isAllowedSettingKey("localAI.ollama.apiKey")).toBe(false);
  });

  it("allowlist covers every key the webview actually writes", () => {
    const webviewWrites = ["autoApproval", "agentMode", "model"];
    for (const key of webviewWrites) {
      expect(isAllowedSettingKey(key), `webview key ${key}`).toBe(true);
    }
  });
});