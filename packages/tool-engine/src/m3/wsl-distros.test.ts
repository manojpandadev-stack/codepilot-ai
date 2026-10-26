/**
 * WSL distro discovery tests (Phase 10, FEATURE_GAP row 16).
 *
 * The `wsl` binary is never invoked — a fake runner feeds deterministic
 * outputs (BOM, CR line endings, localized headers, failures).
 */
import { describe, expect, it } from "vitest";
import {
  parseWslDistroList,
  listWslDistros,
  selectWslDistro,
} from "./wsl-distros.js";

describe("parseWslDistroList", () => {
  it("parses distro names from CRLF output with a BOM", () => {
    const out = "\uFEFFUbuntu-24.04\r\nDebian\r\nUbuntu 22.04 LTS\r\n";
    expect(parseWslDistroList(out)).toEqual([
      "Ubuntu-24.04",
      "Debian",
      "Ubuntu 22.04 LTS",
    ]);
  });

  it("drops the localized no-distros header lines", () => {
    expect(
      parseWslDistroList(
        "Windows Subsystem for Linux has no installed distros.\r\n",
      ),
    ).toEqual([]);
    expect(
      parseWslDistroList(
        "适用于 Linux 的 Windows 子系统没有已安装的分发。\r\n",
      ),
    ).toEqual([]);
  });

  it("de-duplicates repeated names and tolerates empty output", () => {
    expect(parseWslDistroList("Ubuntu\r\nUbuntu\r\n")).toEqual(["Ubuntu"]);
    expect(parseWslDistroList("")).toEqual([]);
    expect(parseWslDistroList("\r\n\r\n")).toEqual([]);
  });
});

describe("listWslDistros", () => {
  it("runs `wsl -l -q` through the injected runner", () => {
    const calls: string[][] = [];
    const distros = listWslDistros({
      runner: (args) => {
        calls.push(args);
        return "Ubuntu-24.04\r\n";
      },
    });
    expect(calls).toEqual([["-l", "-q"]]);
    expect(distros).toEqual(["Ubuntu-24.04"]);
  });

  it("returns [] (never throws) when wsl is unavailable", () => {
    expect(
      listWslDistros({
        runner: () => {
          throw new Error("spawn wsl ENOENT");
        },
      }),
    ).toEqual([]);
  });
});

describe("selectWslDistro", () => {
  it("returns the first installed distro", () => {
    expect(selectWslDistro({ runner: () => "Debian\r\nUbuntu\r\n" })).toBe(
      "Debian",
    );
  });

  it("returns null when no distros are installed", () => {
    expect(
      selectWslDistro({
        runner: () =>
          "Windows Subsystem for Linux has no installed distros.\r\n",
      }),
    ).toBeNull();
  });
});
