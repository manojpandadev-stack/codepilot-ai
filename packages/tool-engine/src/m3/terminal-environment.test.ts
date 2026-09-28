/**
 * TerminalEnvironment tests (Phase 9, FEATURE_GAP row 15).
 *
 * Covers: local/wsl/ssh transport wrapping, SSH alias validation (no
 * credentials/flags/metacharacters can ever ride in the transport),
 * settings-spec parsing, stdin-pipeline refusal for ssh, and executor
 * wiring (the environment reaches CommandExecutionService as argv).
 */
import { describe, expect, it } from "vitest";
import type { CommandExecutionService } from "./command-execution.js";
import {
  createStreamingShellExecutor,
  type StreamingShellContext,
} from "./streaming-shell.js";
import {
  localTerminalEnvironment,
  wslTerminalEnvironment,
  sshTerminalEnvironment,
  parseTerminalEnvironment,
  describeTerminalEnvironment,
} from "./terminal-environment.js";

const ctx: StreamingShellContext = { toolCallId: "call-env-1" };

describe("TerminalEnvironment — wrapping", () => {
  it("local is an identity transport", () => {
    const inv = { command: "bash", args: ["-c", "npm test"] };
    const out = localTerminalEnvironment().wrap(inv);
    expect(out).toBe(inv);
  });

  it("wsl wraps the invocation as `wsl bash -c …` (default distro)", () => {
    const out = wslTerminalEnvironment().wrap({
      command: "bash",
      args: ["-c", "npm test"],
    });
    expect(out).toEqual({ command: "wsl", args: ["bash", "-c", "npm test"] });
  });

  it("wsl wraps with an explicit distro selection", () => {
    const out = wslTerminalEnvironment("Ubuntu-24.04").wrap({
      command: "bash",
      args: ["-c", "npm test"],
    });
    expect(out).toEqual({
      command: "wsl",
      args: ["-d", "Ubuntu-24.04", "bash", "-c", "npm test"],
    });
  });

  it("wsl forwards stdin script payloads unchanged", () => {
    const out = wslTerminalEnvironment().wrap({
      command: "powershell",
      args: ["-NoProfile", "-Command", "boot"],
      input: "npm test",
    });
    expect(out.input).toBe("npm test");
  });

  it("ssh wraps as `ssh <alias> <command> <args…>`", () => {
    const out = sshTerminalEnvironment("prod").wrap({
      command: "bash",
      args: ["-c", "npm test"],
    });
    expect(out).toEqual({
      command: "ssh",
      args: ["prod", "bash", "-c", "npm test"],
    });
  });

  it("ssh refuses stdin pipelines (cannot forward them portably)", () => {
    expect(() =>
      sshTerminalEnvironment("prod").wrap({
        command: "powershell",
        args: ["-Command", "boot"],
        input: "npm test",
      }),
    ).toThrow(/stdin script pipelines/);
  });
});

describe("TerminalEnvironment — ssh alias validation (no credentials)", () => {
  it("rejects userinfo, ports, flags, metacharacters, and empty aliases", () => {
    for (const bad of [
      "user@host",
      "host:2222",
      "host -p password",
      "-o ProxyCommand=evil",
      "host;rm -rf /",
      "host|cat",
      "host key",
      "",
      "host\tname",
    ]) {
      expect(
        () => sshTerminalEnvironment(bad),
        JSON.stringify(bad),
      ).toThrow(/alias rejected/);
    }
  });

  it("accepts plain hosts and config aliases", () => {
    for (const good of ["prod", "web-01", "db.primary", "a"]) {
      expect(sshTerminalEnvironment(good).kind).toBe("ssh");
    }
  });
});

describe("TerminalEnvironment — settings spec parsing", () => {
  it("parses local, wsl, wsl:distro, and ssh:alias", () => {
    expect(parseTerminalEnvironment("local").kind).toBe("local");
    expect(parseTerminalEnvironment("wsl").label).toBe("WSL");
    expect(parseTerminalEnvironment("wsl:Ubuntu").label).toBe(
      "WSL (Ubuntu)",
    );
    expect(parseTerminalEnvironment("ssh:prod").label).toBe("SSH (prod)");
    expect(parseTerminalEnvironment("  ssh:prod  ").kind).toBe("ssh");
  });

  it("rejects unknown specs and missing parameters", () => {
    expect(() => parseTerminalEnvironment("docker")).toThrow(
      /unknown terminal environment/,
    );
    expect(() => parseTerminalEnvironment("wsl:")).toThrow(/needs a distro/);
    expect(() => parseTerminalEnvironment("ssh:")).toThrow(
      /needs a host alias/,
    );
  });

  it("labels are human-readable", () => {
    expect(describeTerminalEnvironment(parseTerminalEnvironment("local"))).toBe(
      "Local",
    );
  });
});

describe("TerminalEnvironment — executor wiring", () => {
  function capturingService() {
    const requests: Record<string, unknown>[] = [];
    const service = {
      run: async (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          cancelled: false,
        };
      },
    };
    return {
      service: service as unknown as CommandExecutionService,
      requests,
    };
  }

  it("routes the invocation through the selected environment as argv", async () => {
    const { service, requests } = capturingService();
    const execute = createStreamingShellExecutor(service, {
      environment: sshTerminalEnvironment("prod"),
    });
    const out = await execute(
      { command: "bash", args: ["-c", "npm test"] },
      process.cwd(),
      ctx,
    );
    expect(out).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe("ssh");
    expect(requests[0]?.args).toEqual(["prod", "bash", "-c", "npm test"]);
  });

  it("passes the invocation through untouched for local", async () => {
    const { service, requests } = capturingService();
    const execute = createStreamingShellExecutor(service, {
      environment: localTerminalEnvironment(),
    });
    await execute(
      { command: "bash", args: ["-c", "npm test"] },
      process.cwd(),
      ctx,
    );
    expect(requests[0]?.command).toBe("bash");
    expect(requests[0]?.args).toEqual(["-c", "npm test"]);
  });

  it("works with no environment configured (default local behavior)", async () => {
    const { service, requests } = capturingService();
    const execute = createStreamingShellExecutor(service);
    await execute(
      { command: "bash", args: ["-c", "npm test"] },
      process.cwd(),
      ctx,
    );
    expect(requests[0]?.command).toBe("bash");
  });
});
