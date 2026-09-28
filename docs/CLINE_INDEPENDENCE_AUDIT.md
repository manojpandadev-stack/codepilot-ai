# CodePilot AI — Cline Independence Audit

**Audit date:** 2026-09-28
**Scope:** repository-wide search across source (`.ts`/`.tsx`/`.js`), `package.json` manifests, `pnpm-lock.yaml`, and build output.
**Goal:** prove Zero Cline runtime/dependency/copy in the production product.

---

## Result summary

| Check | Result |
|---|---|
| Production `@cline/*` dependency | **0** |
| Cline runtime in production code | **0** |
| `ClineCore` in production code | **0** |
| Copied Cline source implementation | **0** |
| `@cline/*` in any `package.json` | **0** |
| `@cline/*` in `pnpm-lock.yaml` | **0** |

**Verdict: CLEAN.** No Cline runtime, dependency, or copied source in the production product.

---

## Evidence

### 1. Dependency manifests
A search for `@cline` across every `package.json` in the workspace returns **zero** matches. The only external production dependencies are `@modelcontextprotocol/sdk`, `react`, `react-dom`, `playwright-core`, `simple-git`, and `pg` (see `DEPENDENCY_LICENSE_AUDIT.md`). All `@codepilot/*` packages are `workspace:*` (first-party).

### 2. Lockfile
A search for `@cline` in `pnpm-lock.yaml` returns **zero** matches — Cline packages are not resolved, linked, or bundled.

### 3. Source search
A repository-wide search for `@cline`, `ClineCore`, and `cline` (excluding `node_modules`, `dist`, `release-verification`) finds only:

| Location | Nature | Classification |
|---|---|---|
| `packages/context-engine/src/index.ts` | `.clinerules/` **project-rules feature** — reads a directory name that Cline also uses; no Cline code | Legitimate feature (shared convention) |
| `apps/vscode-extension/src/extension.ts` | Same `.clinerules/` rules-loading comment | Legitimate feature |
| `apps/webview/src/App.tsx` | UI label "Project Rules (.clinerules/)" | Legitimate feature |
| `packages/tool-engine/src/m3/shell-platform.ts` | Header comment: "Replaces the `@cline/shared` shell helpers… no Cline source is used" | Legitimate historical note |
| `scripts/benchmark/cline-compare.ts` | **Benchmark comparison script** — imports `@cline/agents` + `@cline/core` to measure tool-authoring/SDK-init cost side-by-side with honest "not measured" policy | **Non-production** (see below) |
| `CLINE_DEPENDENCY_MAP.md`, `docs/CLINE_PARITY_MATRIX.md`, `docs/FEATURE_GAP_MATRIX.md`, `THIRD_PARTY_NOTICES.md`, `docs/PERFORMANCE.md`, `docs/ARCHITECTURE_AUDIT.md`, `docs/PROVIDER_ARCHITECTURE.md` | Documentation / comparison text | Legitimate historical reference |

### 4. The one non-production Cline reference
`scripts/benchmark/cline-compare.ts` imports `@cline/agents` and `@cline/core`. This is a **standalone benchmark probe**, not part of the product:
- It is **not** in any `package.json` dependency list.
- It is **not** in `pnpm-lock.yaml`.
- It is **not** imported by any production module.
- It is **not** bundled into the VSIX (the extension entry is `dist/extension.js`; the script lives under `scripts/benchmark/`).
- Its own header states it is a "Cline comparison probe" that reports non-equivalent operations as "Not measured" and never claims a speedup.

**Recommendation:** keep as a historical comparison artifact, or delete at the acquirer's discretion. It has zero runtime coupling to CodePilot.

### 5. Build output
The production build (`pnpm -r build`) compiles only first-party packages. No Cline module is reachable from `dist/extension.js` or any package `dist/`.

---

## Conclusion

CodePilot AI is **fully independent of Cline** at the runtime, dependency, lockfile, and build-output level. The only Cline mentions are (a) a shared `.clinerules/` directory-name convention implemented natively, (b) documentation/comparison text, and (c) one non-production benchmark script with no runtime coupling.
