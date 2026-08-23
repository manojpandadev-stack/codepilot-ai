import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOOL_POLICIES,
  BLOCKED_COMMANDS,
  IGNORED_INDEX_PATHS,
  SUPPORTED_LANGUAGES,
  OLLAMA_DEFAULT_BASE_URL,
  EXTENSION_ID,
} from "./index.js";

describe("Shared constants", () => {
  it("has sensible default tool policies", () => {
    expect(DEFAULT_TOOL_POLICIES).toBeDefined();

    // Read tools should be auto-approved
    expect(DEFAULT_TOOL_POLICIES["read_files"]).toBe("auto");
    expect(DEFAULT_TOOL_POLICIES["search"]).toBe("auto");
    expect(DEFAULT_TOOL_POLICIES["git_diff"]).toBe("auto");
    expect(DEFAULT_TOOL_POLICIES["git_status"]).toBe("auto");
    expect(DEFAULT_TOOL_POLICIES["list_directory"]).toBe("auto");

    // Write tools should require approval
    expect(DEFAULT_TOOL_POLICIES["write_file"]).toBe("approval");
    expect(DEFAULT_TOOL_POLICIES["apply_patch"]).toBe("approval");
    expect(DEFAULT_TOOL_POLICIES["bash"]).toBe("approval");
  });

  it("has blocked commands list", () => {
    expect(BLOCKED_COMMANDS).toBeInstanceOf(Array);
    expect(BLOCKED_COMMANDS.length).toBeGreaterThan(0);
    expect(BLOCKED_COMMANDS).toContain("rm -rf /");
    expect(BLOCKED_COMMANDS).toContain("mkfs");
  });

  it("has ignored index paths for repository scanning", () => {
    expect(IGNORED_INDEX_PATHS).toContain(".git");
    expect(IGNORED_INDEX_PATHS).toContain("node_modules");
    expect(IGNORED_INDEX_PATHS).toContain("target");
    expect(IGNORED_INDEX_PATHS).toContain("dist");
    expect(IGNORED_INDEX_PATHS).toContain(".env");
  });

  it("has supported languages list", () => {
    expect(SUPPORTED_LANGUAGES).toContain("java");
    expect(SUPPORTED_LANGUAGES).toContain("typescript");
    expect(SUPPORTED_LANGUAGES).toContain("python");
    expect(SUPPORTED_LANGUAGES).toContain("javascript");
  });

  it("has correct Ollama default URL", () => {
    expect(OLLAMA_DEFAULT_BASE_URL).toBe("http://localhost:11434");
  });

  it("has correct extension ID", () => {
    expect(EXTENSION_ID).toBe("codepilot.codepilot-ai");
  });
});

describe("Shared types", () => {
  it("PrivacyMode type works with string literals", () => {
    const local: "local" = "local";
    const hybrid: "hybrid" = "hybrid";
    const cloud: "cloud" = "cloud";
    expect(local).toBe("local");
    expect(hybrid).toBe("hybrid");
    expect(cloud).toBe("cloud");
  });

  it("CodePilotAgentMode type works with string literals", () => {
    const modes: Array<"ask" | "plan" | "act" | "review" | "auto"> = [
      "ask",
      "plan",
      "act",
      "review",
      "auto",
    ];
    expect(modes).toHaveLength(5);
  });

  it("TaskDAGNode shape is correct", () => {
    const node: import("./index.js").TaskDAGNode = {
      id: "task-1",
      parentTaskId: null,
      type: "analyze",
      agent: "architect",
      description: "Analyze repository",
      dependencies: [],
      status: "pending",
      priority: 1,
      files: [],
      result: null,
      errors: [],
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
    expect(node.id).toBe("task-1");
    expect(node.status).toBe("pending");
    expect(node.agent).toBe("architect");
  });

  it("WebviewMessage shape is correct", () => {
    const msg: import("./index.js").WebviewMessage = {
      type: "chat/send",
      id: "msg-1",
      payload: { text: "hello" },
      timestamp: Date.now(),
    };
    expect(msg.type).toBe("chat/send");
    expect(msg.id).toBe("msg-1");
  });
});
