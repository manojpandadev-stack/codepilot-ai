/**
 * Terminal environment abstraction (Phase 9, FEATURE_GAP row 15).
 *
 * A `TerminalEnvironment` wraps a shell invocation so the SAME logical
 * command executes inside the selected transport: local OS shell, WSL, or
 * a remote SSH host. The abstraction lives in the tool engine so every
 * executor (streaming shell, future terminal session paths) shares one
 * definition of "where does this command run".
 *
 * Security model — read carefully:
 * - Transport wrapping happens AFTER M4: the command itself was already
 *   gated/approved (or denied) before this layer sees it. The environment
 *   only changes where an approved command executes, never whether.
 * - NO plaintext credentials, ever. SSH transport accepts exactly one
 *   config alias/hostname token (`SSH_ALIAS_PATTERN` — no `@`, `:`, `=`,
 *   whitespace, or flag characters). Authentication is exclusively the
 *   user's OS credential mechanisms: `~/.ssh/config` (IdentityFile,
 *   ProxyCommand) and ssh-agent. The wrapper never adds `-i`, `-p`,
 *   `-o`, or any credential-bearing flag, and rejects stdin pipelines
 *   (ssh cannot forward them portably).
 * - The command rides as spawn ARGV (never string-interpolated into a
 *   local shell line), so alias/command content cannot break out of the
 *   transport the way naive `ssh host "cmd"` string building could.
 */

import type { ShellInvocation } from "./shell-platform.js";

export type TerminalEnvironmentKind = "local" | "wsl" | "ssh";

export interface TerminalEnvironment {
  readonly kind: TerminalEnvironmentKind;
  /** Human label for settings UI ("Local", "WSL (Ubuntu)", "SSH (prod)"). */
  readonly label: string;
  /**
   * Wrap a shell invocation so the command executes inside this
   * environment. Input is the SAME shape `getShellInvocation` returns;
   * `input` (stdin script) support depends on the transport.
   */
  wrap(invocation: ShellInvocation): ShellInvocation;
}

/**
 * SSH alias/hostname: a single DNS-label-ish token. The pattern rejects
 * userinfo (`user@host`), ports (`host:2222`), flags (`-o …`), and any
 * shell metacharacters — credentials and smuggling are structurally
 * impossible.
 */
const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function localTerminalEnvironment(): TerminalEnvironment {
  return {
    kind: "local",
    label: "Local",
    wrap: (invocation) => invocation,
  };
}

export function wslTerminalEnvironment(distro?: string): TerminalEnvironment {
  return {
    kind: "wsl",
    label: distro ? `WSL (${distro})` : "WSL",
    wrap: (invocation) => ({
      command: "wsl",
      args:
        distro !== undefined
          ? ["-d", distro, invocation.command, ...invocation.args]
          : [invocation.command, ...invocation.args],
      ...(invocation.input !== undefined ? { input: invocation.input } : {}),
    }),
  };
}

export function sshTerminalEnvironment(alias: string): TerminalEnvironment {
  if (!SSH_ALIAS_PATTERN.test(alias)) {
    throw new Error(
      `ssh terminal environment alias rejected: ${JSON.stringify(alias)} — ` +
        `use a plain host or ~/.ssh/config alias; credentials, ports, flags, ` +
        `and shell metacharacters are never embedded in the transport`,
    );
  }
  return {
    kind: "ssh",
    label: `SSH (${alias})`,
    wrap: (invocation) => {
      if (invocation.input !== undefined) {
        throw new Error(
          "ssh transport does not support stdin script pipelines " +
            "(PowerShell bootstrap input); re-run without a shell that " +
            "requires stdin",
        );
      }
      // `ssh <alias> <command> <args…>` — ssh joins the trailing args with
      // spaces and runs them through the remote login shell. The command
      // itself travels as argv, never re-parsed locally.
      return {
        command: "ssh",
        args: [alias, invocation.command, ...invocation.args],
      };
    },
  };
}

/** Parse a settings spec: `local`, `wsl[:distro]`, `ssh:<alias>`. */
export function parseTerminalEnvironment(spec: string): TerminalEnvironment {
  const s = spec.trim();
  const scheme = s.toLowerCase();
  if (scheme === "local") return localTerminalEnvironment();
  if (scheme === "wsl") return wslTerminalEnvironment();
  if (scheme.startsWith("wsl:")) {
    const distro = s.slice(4).trim();
    if (distro.length === 0) {
      throw new Error(
        `wsl terminal environment needs a distro: ${JSON.stringify(spec)}`,
      );
    }
    return wslTerminalEnvironment(distro);
  }
  if (scheme.startsWith("ssh:")) {
    const alias = s.slice(4).trim();
    if (alias.length === 0) {
      throw new Error(
        `ssh terminal environment needs a host alias: ${JSON.stringify(spec)}`,
      );
    }
    return sshTerminalEnvironment(alias);
  }
  throw new Error(
    `unknown terminal environment: ${JSON.stringify(spec)} ` +
      `(expected local | wsl[:distro] | ssh:<alias>)`,
  );
}

/** Human label for the environment (settings UI, logs). */
export function describeTerminalEnvironment(env: TerminalEnvironment): string {
  return env.label;
}
