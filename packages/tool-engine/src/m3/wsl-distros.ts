/**
 * WSL distro discovery (Phase 10, FEATURE_GAP row 16).
 *
 * Lists installed WSL distros via `wsl -l -q` and selects a default, so
 * the `wsl[:distro]` terminal environment (Phase 9) can be driven by real
 * machine state instead of a hand-typed guess.
 *
 * Robustness contract:
 * - NEVER throws. WSL absent, `wsl.exe` missing, non-Windows hosts, or a
 *   non-zero exit all yield `[]` — discovery is best-effort.
 * - Output parsing strips BOM/CR and drops the localized "no distros"
 *   header line (English + zh-CN variants); distro names are otherwise
 *   kept verbatim (they may contain spaces, e.g. "Ubuntu 22.04 LTS").
 * - The list command is bounded (5s) so a hung WSL service cannot stall
 *   the host.
 */

import { execFileSync } from "node:child_process";

/** Bounded `wsl` invocation so a hung WSL service cannot stall the host. */
export const WSL_LIST_TIMEOUT_MS = 5_000;

/** Injectable runner (tests); defaults to a bounded `wsl` exec. */
export type WslListRunner = (args: string[]) => string;

function defaultRunner(args: string[]): string {
  return execFileSync("wsl", args, {
    encoding: "utf8",
    timeout: WSL_LIST_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Localized "no installed distros" header lines printed by `wsl -l`. */
const WSL_HEADER_PATTERNS = [
  /^windows subsystem for linux has no installed distros\.?$/i,
  /^适用于 linux 的 windows 子系统没有已安装的分发\.?$/,
  /没有已安装的分发/,
];

function isHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return WSL_HEADER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Parse `wsl -l -q` output into de-duplicated distro names. */
export function parseWslDistroList(output: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (line.length === 0 || isHeaderLine(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    names.push(line);
  }
  return names;
}

/** List installed WSL distro names; `[]` when WSL is unavailable. */
export function listWslDistros(options?: {
  runner?: WslListRunner;
}): string[] {
  const run = options?.runner ?? defaultRunner;
  try {
    return parseWslDistroList(run(["-l", "-q"]));
  } catch {
    return [];
  }
}

/** First installed distro (the conventional default), or null. */
export function selectWslDistro(options?: {
  runner?: WslListRunner;
}): string | null {
  return listWslDistros(options)[0] ?? null;
}
