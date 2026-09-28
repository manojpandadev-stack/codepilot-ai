# CodePilot AI — Technical Due Diligence Checklist

| Area | Status | Evidence |
|---|---|---|
| Source code | VERIFIED | 11 first-party packages, TypeScript ESM |
| Architecture | VERIFIED | `03_ARCHITECTURE.md` |
| Dependencies | VERIFIED | `12_DEPENDENCY_LICENSES.md` — 6 direct, permissive |
| Licenses | VERIFIED | MIT/Apache-2.0/ISC/BSD-2; no copyleft |
| Security | VERIFIED | M4, SSRF 44/44, redaction, boundaries |
| Tests | VERIFIED | 2547/2547, 161 files |
| Build | VERIFIED | `pnpm -r build` PASS |
| VSIX | VERIFIED | 124 files, 3.64 MB, 0 forbidden entries |
| Providers | PARTIAL | Ollama live; cloud not live-verified; Bedrock discovery-only; Azure not implemented |
| Browser | VERIFIED | 17/17 real-Chromium E2E |
| MCP | VERIFIED | 72/72 incl. hung-server regression |
| Persistence | VERIFIED | tasks, checkpoints, approval timeline, corruption quarantine |
| IP | VERIFIED | 0 Cline; first-party packages owned |
| Documentation | VERIFIED | `docs/` + `docs/acquisition/` (20 files) |
| Known limitations | VERIFIED | `15_KNOWN_LIMITATIONS.md` |
| Handover | VERIFIED | `18_HANDOVER_PLAN.md` |
| Live model demo | NOT VERIFIED | qwen3:8b model limitation (browser loop) |
| Cloud provider live | NOT VERIFIED | No credentials available |
| Azure | NOT IMPLEMENTED | No adapter |
| Bedrock generation | NOT IMPLEMENTED | Discovery-only |
| Extension manifest identity | NOT VERIFIED | publisher/license/repo require user input |
| Brand/domain ownership | NOT VERIFIED | Not established in this audit |

**No security rule was relaxed. No regression was ignored. Repository remains uncommitted and unpublished.**
