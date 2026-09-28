# Skills — Product Decision and Guarantees

**Status:** Authoritative product decision for the Skills feature.
**Date:** 2026-09-24

## Decision

CodePilot AI ships **NO bundled first-party skills** in this release. The
product position is:

- Skills are a **user-provided extension surface**, not shipped content.
- Discovery is **deterministic** and scans exactly two documented locations:
  - `<workspace>/.codepilot/skills/**/*.md` — project skills
  - `~/.codepilot/skills/**/*.md` — global skills
- Markdown files carry `name:`/`description:` frontmatter (M9 rules-engine
  format). Deterministic ordering: sorted by name.

## UI states (EMPTY ≠ ERROR)

The WebView must distinguish, and the host makes distinguishable:

| State | Meaning | UI |
|---|---|---|
| Loading | Discovery request in flight | "Loading skills…" |
| EMPTY | Discovery succeeded, zero skills found | "No skills discovered" (honest — no fake suggestions) |
| ERROR | Discovery/list request failed | "Unable to load skills — Retry" |

Regression coverage: `tests/tools-skills-team-integration.test.ts` asserts
the host answers `skills/list_result` (a real, possibly empty, array) and
that a genuine empty workspace is never classified as a load failure
(`isLoadFailureState(null, 0) === false`).

## Guarantees (unchanged by this decision)

- **Only ACTIVE skills join the next prompt** — and activation is
  user-controlled per turn. Bounded context: at most 8 active skills,
  2,000 chars each, 8,000 chars total (`agent-context-service.ts`).
- Skills **never bypass**:
  - M4 tool approval (every tool call from every path evaluates live),
  - the security/policy engine,
  - terminal approval,
  - filesystem policy,
  - runtime authorization.
- `allowedTools` declarations from active skills only ever **shrink** the
  tool set (union of denials, never an escalation path).
- No Cline skill content is shipped or copied; this is an independent
  first-party mechanism (M9 rules + skills engine).

## Refresh / reload semantics

- The Skills panel has an explicit Refresh action (`skills/list`).
- WebView reload re-bootstraps and re-requests `skills/list`; the list is
  never permanently lost.
- `skills/error` responses surface as ERROR state, never silently as EMPTY.
