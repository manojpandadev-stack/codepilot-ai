// ============================================================================
// Verification panel — honest presentation of verification evidence.
//
// Five explicit states (NOT VERIFIED / VERIFYING / VERIFIED / FAILED /
// NOT AVAILABLE). Evidence rows come from real runtime data; signals the
// backend does not emit (tests, build, typecheck, security) render as
// "Not available" rows — never a fabricated checkmark. State is conveyed by
// text + icon, never by color alone.
// ============================================================================

import { IconCheck, IconRefresh, IconWarning, IconX } from "../lib/icons";
import { Badge, Button } from "../lib/ui";
import {
  verificationEvidenceRows,
  verificationLabel,
  type VerificationView,
} from "../lib/controlcenter";
import type { VerificationCheckMsg } from "../lib/messages";

function stateIcon(state: VerificationView["status"]) {
  if (state === "verified") return <IconCheck size={13} />;
  if (state === "failed") return <IconX size={13} />;
  if (state === "verifying")
    return <IconRefresh size={13} className="cp-pulse" />;
  if (state === "not-available") return <IconWarning size={13} />;
  return <IconWarning size={13} />;
}

export function VerificationPanel({
  verification,
  problemsCount,
  okCommands,
  failedCommands,
  onCheckProblems,
  engineChecks,
  onRunVerification,
}: {
  verification: VerificationView;
  problemsCount: number | null;
  okCommands: number;
  failedCommands: number;
  onCheckProblems: () => void;
  /** Real Verification Engine results; null = no run has happened yet. */
  engineChecks: VerificationCheckMsg[] | null;
  /** Ask the host to run the verification orchestrator (safe executor). */
  onRunVerification: () => void;
}) {
  const tone =
    verification.status === "verified"
      ? "success"
      : verification.status === "failed"
        ? "danger"
        : verification.status === "verifying"
          ? "info"
          : "muted";

  const rows = verificationEvidenceRows({
    problemsCount,
    okCommands,
    failedCommands,
  });

  // ENGINE RESULTS — real rows replace the static "Not available" rows only
  // for checks the engine actually modeled. Checks absent from the payload
  // keep the honest placeholder behavior (no fabricated pass).
  const engineByType = new Map((engineChecks ?? []).map((c) => [c.type, c]));
  const ENGINE_LABEL: Record<VerificationCheckMsg["type"], string> = {
    tests: "Tests",
    build: "Build",
    typecheck: "Typecheck",
    security: "Security checks",
  };
  const ENGINE_STATUS_LABEL: Record<VerificationCheckMsg["status"], string> = {
    not_started: "Not started",
    running: "Running",
    passed: "PASSED",
    failed: "FAILED",
    cancelled: "Cancelled",
    timeout: "Timeout",
    not_available: "Not available",
  };

  return (
    <section
      aria-label="Verification"
      className="flex-shrink-0 border-b border-vscode-border px-3 py-2 space-y-1.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-vscode-title">
          Verification
        </span>
        <Badge tone={tone} title={verification.detail}>
          {stateIcon(verification.status)} {verification.label}
        </Badge>
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            onClick={onRunVerification}
            aria-label="Run verification checks now"
            title="Run the applicable checks (tests, build, typecheck, security) through the host's safe execution service"
          >
            <IconRefresh size={10} /> Run checks
          </Button>
          <Button
            size="xs"
            onClick={onCheckProblems}
            aria-label="Check workspace problems now"
            title="Ask the host for live VS Code diagnostics (real verification evidence)"
          >
            Check problems
          </Button>
        </span>
      </div>

      <p className="text-[10px] text-vscode-desc break-words">
        {verification.detail}
      </p>

      <ul className="space-y-0.5" aria-label="Verification evidence">
        {rows.map((row) => {
          const engineKey =
            row.key === "tests"
              ? "tests"
              : row.key === "build"
                ? "build"
                : row.key === "typecheck"
                  ? "typecheck"
                  : row.key === "security"
                    ? "security"
                    : null;
          const engine = engineKey ? engineByType.get(engineKey) : undefined;
          if (engine) {
            // Real engine row: status text is authoritative; failure detail
            // is bounded and human-readable (never a raw output dump).
            const failed =
              engine.status === "failed" ||
              engine.status === "timeout" ||
              engine.status === "cancelled";
            return (
              <li
                key={row.key}
                className="flex items-center gap-2 text-[10px] font-mono"
                title={
                  engine.error
                    ? `${engine.summary} — ${engine.error}`
                    : engine.summary
                }
              >
                <span className="text-vscode-desc w-24 flex-shrink-0">
                  {ENGINE_LABEL[engine.type]}
                </span>
                <span
                  className={
                    engine.status === "passed"
                      ? "text-vscode-success-fg"
                      : failed
                        ? "text-vscode-error-fg"
                        : "text-vscode-fg"
                  }
                >
                  {ENGINE_STATUS_LABEL[engine.status]}
                  {engine.exitCode != null && engine.exitCode !== 0
                    ? ` (exit ${engine.exitCode})`
                    : ""}
                </span>
              </li>
            );
          }
          return (
            <li
              key={row.key}
              className="flex items-center gap-2 text-[10px] font-mono"
            >
              <span className="text-vscode-desc w-24 flex-shrink-0">
                {row.label}
              </span>
              {row.kind === "unavailable" ? (
                <span
                  className="text-vscode-desc italic"
                  title="The backend does not report this signal yet"
                >
                  — Not available
                </span>
              ) : (
                <span className="text-vscode-fg truncate" title={row.value}>
                  {row.value}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Re-exported for consumers that want the label helper without reaching into
// the derivation module.
export { verificationLabel };
