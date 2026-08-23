import { CodePilotRuntime } from "./runtime.js";
import type { CodePilotRuntimeOptions } from "./types.js";

/**
 * Create a new CodePilotRuntime instance.
 *
 * This is the primary factory function for creating a fully configured
 * runtime that wraps ClineCore with CodePilot-specific defaults.
 *
 * @example
 * ```ts
 * const runtime = await createCodePilotRuntime({
 *   workspaceRoot: "/path/to/project",
 *   providerId: "ollama",
 *   modelId: "qwen2.5-coder:7b",
 *   privacyMode: "local",
 * });
 *
 * await runtime.initialize();
 * const sessionId = await runtime.startSession("Add Redis caching to OrderService");
 * ```
 */
export async function createCodePilotRuntime(
  options: CodePilotRuntimeOptions,
): Promise<CodePilotRuntime> {
  const runtime = new CodePilotRuntime(options);
  await runtime.initialize();
  return runtime;
}
