# CodePilot AI — Persistence & Recovery

## What persists

- **Tasks** — conversation, tool calls, metrics, images (per-task directory).
- **Checkpoints** — file snapshots with conflict detection, durable across restarts (atomic JSON, seq-continued, corrupt quarantine).
- **Command repair history** — bounded attempts per command.
- **Approval timeline** — requested/denied/granted events with timestamps and fingerprints; no secrets.
- **Audit log** — redacted tool audit JSONL.
- **MCP config** — servers with redacted env/headers.

## Recovery

- Restart: tasks, checkpoints, and approval timeline reload; corrupt files quarantined (renamed `.corrupt-*`), never thrown.
- Resume: paused tasks resume with full context.
- Ownership: checkpoint restore enforces task ownership host-side.

## Corruption handling

Every persistence layer uses atomic writes (tmp+rename) and quarantine-on-corrupt. No silent approval replay. No privilege escalation from corrupt data.

## Evidence

Persistence suites: task store, checkpoint durability (6 tests), approval timeline, corruption quarantine, history reopen regression.
