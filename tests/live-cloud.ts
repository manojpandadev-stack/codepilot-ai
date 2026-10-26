/**
 * Live-cloud opt-in flag (test-only, no production code).
 *
 * The normal suite must pass with NO API key, NO paid model, NO Ollama
 * installation, and NO network access. Tests that genuinely need the live
 * network (e.g. asserting a real provider's HTTP verdict for a fake key)
 * gate themselves behind CODEPILOT_LIVE_CLOUD=1 and skip otherwise:
 *
 *   import { LIVE_CLOUD } from "./live-cloud";
 *   describe.skipIf(!LIVE_CLOUD)("...", ...)
 *
 * Opt-in live tests never print credentials and never retry auth failures.
 */
export const LIVE_CLOUD: boolean =
  process.env.CODEPILOT_LIVE_CLOUD === "1";

export const LIVE_CLOUD_SKIP_REASON =
  "skipped: needs CODEPILOT_LIVE_CLOUD=1 (live network)";
