# CodePilot AI — Terminal & Execution

## Streaming shell

Host-side bash executor with live `terminal.*` event streaming. Output capped at 48k (middle-truncation with metadata). Full output persisted to an outputRef sidecar (bounded, redacted) and retrievable via `read_tool_output` with offset/max_chars slicing.

## Interactive stdin

Persistent interactive shell per agent session (`keepStdinOpen`). `terminal_session_write_stdin` feeds REPLs/prompts line-by-line (bounded 8k/write). Ctrl+C via stdin on stop. Shell killed on close/cancel.

## Command repair loop

Bounded diagnose→edit→rerun loop (`MAX_AUTO_REPAIR_ATTEMPTS=3`). Classifies failures (transient/network/missing-module/non-recoverable), applies safe transforms, re-gates transformed commands through M4. Persisted attempts, loop guard, corrupt quarantine. Non-recoverable failures never rerun.

## run_commands

Single or sequential commands, streaming or completion-oriented. Bounded per-command (8k) and joined output. Sidecar-aware truncation.

## Evidence

Terminal suites: streaming shell, interactive stdin, command repair loop (20 tests), outputRef sidecar (8 tests), live terminal streaming.
