# CodePilot AI — Dependencies & Licenses

CodePilot does not use Cline runtime/source. Identified third-party components are separately documented and permissively licensed, subject to their license obligations.

## Direct dependencies (production)

| Package | Version | License | Role |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.30.1 | MIT | MCP transports |
| `react` | 19.2.8 | MIT | WebView UI |
| `react-dom` | 19.2.8 | MIT | WebView UI |
| `playwright-core` | 1.63.0 | Apache-2.0 | Browser automation |
| `simple-git` | 3.36.0 | MIT | Git tools |
| `pg` | 8.23.0 | MIT | RAG vector store |

## Transitive policy

All transitive dependencies are MIT/ISC/BSD-2-Clause. No GPL/AGPL/LGPL/SSPL/BUSL/Commons Clause/source-available/non-commercial licenses found.

## License obligations

- **MIT/ISC/BSD-2-Clause** — retain copyright + license notice in distributions.
- **Apache-2.0 (playwright-core)** — retain NOTICE + license; state changes. Attribution required in product documentation.

## Classification

- KEEP — all 6 direct dependencies.
- PLATFORM API — `vscode` (Extension API, not npm).
- LEGAL REVIEW — none required at this time.
- REPLACE / UNKNOWN — none.

Full detail: `docs/DEPENDENCY_LICENSE_AUDIT.md`.
