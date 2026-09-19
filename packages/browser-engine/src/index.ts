/**
 * @codepilot/browser-engine
 *
 * Real browser automation for the CodePilot agent: isolated ephemeral
 * Chromium sessions over playwright-core with request-level SSRF
 * enforcement, M3 ToolDefinition tools, and a secret-free audit trail.
 *
 * Flow: agent → browser_* tool → ToolRegistry → ToolExecutionService →
 * M4 (RiskEngine → PolicyEngine → ApprovalManager → SecurityValidator) →
 * BrowserService → Chromium.
 */

export { BrowserService } from "./browser-service.js";
export type {
  BrowserServiceOptions,
  BrowserAuditEntry,
  NavigateResult,
  PageSnapshot,
} from "./browser-service.js";
export { createBrowserTools } from "./browser-tools.js";
export type { BrowserToolConfig } from "./browser-tools.js";
export {
  validateTargetUrl,
  validateRedirectTarget,
  safeTargetOf,
  hostnameOf,
  checkHostnameTextual,
} from "./url-policy.js";
export type {
  UrlPolicyDecision,
  UrlPolicyOptions,
  UrlPolicyVerdict,
} from "./url-policy.js";
