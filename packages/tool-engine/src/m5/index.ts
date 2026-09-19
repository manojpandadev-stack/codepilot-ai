/**
 * @codepilot/tool-engine — M5 exports
 *
 * M5 (file mutation / changeset / diff / checkpoints) is built on top of the
 * existing M3 ToolRegistry + M4 Permission Pipeline. The core services live in
 * @codepilot/changeset-engine; this module supplies the production adapter that
 * binds them onto the M3/M4 security primitives and exposes them as M3 tools.
 */

export { M5PathGuard } from "./security-adapter.js";
export type { M5PathGuardOptions } from "./security-adapter.js";

export { createM5Toolchain, createM5Tools, createM5Toolset } from "./tools.js";
export type { M5ToolOptions, M5Toolchain } from "./tools.js";
