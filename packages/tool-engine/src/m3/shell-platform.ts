/**
 * CodePilot shell platform selection — independent implementation.
 *
 * Replaces the `@cline/shared` shell helpers used by the streaming shell
 * executor. The behavior contract below was pinned by observing the previous
 * implementation's OUTPUT (probe + tests) and re-implementing it from public
 * OS/shell knowledge — no Cline source is used:
 *
 *   `getDefaultShell(platform)`:
 *     - win32  → "powershell" (WindowsApps/PowerShell execution alias; the
 *       probe lives in the consumer test, which asserts the resolved default
 *       is a real shell on the current machine)
 *     - linux/darwin → basename of `$SHELL` if set, else "bash"
 *       (always a bare name resolved through PATH — see contract below)
 *
 *   Contract: the default is a *bare shell name* ("powershell", "bash", …)
 *   resolved through PATH at spawn time — never an absolute path — so the
 *   same logical value works across machines and platforms (and so the
 *   invocation builder can key shell kind off the basename safely).
 *
 *   `getShellInvocation(shell, command)` → `{ command, args, input? }`:
 *     - powershell family → spawn `powershell` with a UTF-8 bootstrap that
 *       reads the user's script from STDIN (`$c=[Console]::In.ReadToEnd()`),
 *       appends an exit-code check, and invokes it as a script block. The
 *       command travels via `input`, never the command line — Unicode-safe
 *       and quote-safe.
 *     - cmd family → `/d /s /c <command>`.
 *     - wsl → `bash -c <command>` (wsl.exe launches the default distro).
 *     - posix (bash/zsh/sh/…) → `-c <command>` (login shells get `-l -c`).
 */

export interface ShellInvocation {
  /** Executable to spawn. */
  command: string;
  /** Argument list; the user's script rides in `input` for PowerShell. */
  args: string[];
  /** Script body for shells that read the command from stdin. */
  input?: string;
}

export type ShellKind = "powershell" | "cmd" | "wsl" | "posix";

/** Classify a shell executable (bare name or full path) into its family. */
export function getShellKind(shell: string): ShellKind {
  const base = (shell.split(/[\\/]/).pop() ?? shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (base === "powershell" || base === "pwsh") return "powershell";
  if (base === "cmd") return "cmd";
  if (base === "wsl") return "wsl";
  return "posix";
}

/** The default shell executable for the given platform. */
export function getDefaultShell(platform: string): string {
  if (platform === "win32") {
    // "powershell" resolves via PATH/App Execution Aliases to Windows
    // PowerShell 5.1 (or pwsh when the consumer's probe finds it first).
    return "powershell";
  }
  const shell = process.env.SHELL;
  if (shell && shell.trim().length > 0) {
    // Contract: bare shell name (resolved via PATH), not an absolute path.
    const base = shell.split("/").pop() ?? shell;
    return base.length > 0 ? base : "bash";
  }
  return "bash";
}

/** UTF-8 bootstrap: script arrives via stdin; exit code propagates. */
const POWERSHELL_STDIN_BOOTSTRAP =
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new();" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();" +
  "$c=[Console]::In.ReadToEnd();" +
  "$c+=[Environment]::NewLine+'if(-not $?){exit 1}';" +
  "& ([ScriptBlock]::Create($c))";

/**
 * Build the invocation (executable + args + optional stdin payload) that
 * runs `command` under `shell`.
 */
export function getShellInvocation(
  shell: string,
  command: string,
): ShellInvocation {
  switch (getShellKind(shell)) {
    case "powershell":
      return {
        command: shell,
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          POWERSHELL_STDIN_BOOTSTRAP,
        ],
        input: command,
      };
    case "cmd":
      return { command: shell, args: ["/d", "/s", "/c", command] };
    case "wsl":
      return { command: shell, args: ["bash", "-c", command] };
    case "posix":
    default: {
      const base = shell.split("/").pop() ?? shell;
      // sh/dash don't support -l meaningfully; everything else gets a login
      // shell so the user's profile environment is inherited.
      const args =
        base === "sh" || base === "dash"
          ? ["-c", command]
          : ["-l", "-c", command];
      return { command: shell, args };
    }
  }
}
