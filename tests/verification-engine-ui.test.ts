/**
 * Verification Engine — frontend state tests.
 *
 * The webview receives verification/state events; these tests pin the
 * reducer contract that keeps the Control Center honest:
 *  - checks render in stable order regardless of arrival order;
 *  - a late `running` event never downgrades a settled status;
 *  - checks the engine never modeled stay ABSENT (the panel keeps its
 *    honest "Not available" placeholder — no fabricated pass).
 */

import { describe, expect, it } from "vitest";
import {
  reduceVerificationState,
  type VerificationCheckMsg,
  type VerificationStateMsg,
} from "../apps/webview/src/lib/messages";

function check(
  type: VerificationCheckMsg["type"],
  status: VerificationCheckMsg["status"],
  extra?: Partial<VerificationCheckMsg>,
): VerificationCheckMsg {
  return { type, status, summary: `${type}:${status}`, ...extra };
}

function payload(
  checks: VerificationCheckMsg[],
  over?: Partial<VerificationStateMsg>,
): VerificationStateMsg {
  return {
    runId: "r1",
    status: "completed",
    checks,
    ...over,
  };
}

describe("reduceVerificationState", () => {
  it("orders checks in the stable display order", () => {
    const next = reduceVerificationState(
      [],
      payload([
        check("security", "not_available"),
        check("typecheck", "passed"),
        check("tests", "passed"),
        check("build", "failed"),
      ]),
    );
    expect(next.map((c) => c.type)).toEqual([
      "tests",
      "build",
      "typecheck",
      "security",
    ]);
  });

  it("a late running event never downgrades a settled status", () => {
    const settled = reduceVerificationState(
      [],
      payload([check("tests", "passed")]),
    );
    const late = reduceVerificationState(
      settled,
      payload([check("tests", "running")]),
    );
    expect(late[0]!.status).toBe("passed");
  });

  it("keeps never-modeled checks absent so placeholders stay honest", () => {
    const next = reduceVerificationState(
      [],
      payload([check("tests", "passed")]),
    );
    expect(next.map((c) => c.type)).toEqual(["tests"]);
    expect(next.find((c) => c.type === "build")).toBeUndefined();
  });

  it("failure details survive the reduction", () => {
    const next = reduceVerificationState(
      [],
      payload([
        check("build", "failed", {
          exitCode: 2,
          error: "TS2304: Cannot find name 'x'",
          durationMs: 1500,
        }),
      ]),
    );
    const build = next.find((c) => c.type === "build")!;
    expect(build.status).toBe("failed");
    expect(build.exitCode).toBe(2);
    expect(build.error).toContain("TS2304");
  });

  it("cancelled and timeout checks keep their distinct statuses", () => {
    const next = reduceVerificationState(
      [],
      payload([check("tests", "cancelled"), check("build", "timeout")]),
    );
    expect(next.map((c) => c.status)).toEqual(["cancelled", "timeout"]);
  });

  it("a subsequent run's settled results replace running state", () => {
    const running = reduceVerificationState(
      [],
      payload([check("tests", "running")], { status: "running" }),
    );
    const done = reduceVerificationState(
      running,
      payload([check("tests", "failed")], {
        status: "completed",
        verdict: "failed",
        runId: "r2",
      }),
    );
    expect(done[0]!.status).toBe("failed");
  });
});
