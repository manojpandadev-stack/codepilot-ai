# CodePilot AI — Build & Release

## Build

```bash
pnpm install
pnpm -r typecheck   # 19/19 packages
pnpm -r build       # tsc + esbuild
```

## VSIX packaging

```bash
cd apps/vscode-extension
pnpm exec vsce package --no-dependencies --out <name>.vsix
```

## VSIX audit (2026-09-28, final freeze)

| Field | Value |
|---|---|
| Filename | `codepilot-freeze-20260928.vsix` |
| Size | 3,817,993 bytes (3.64 MB) |
| Unpacked | 16,574,322 bytes (15.8 MB) |
| Files | 124 |
| SHA-256 | `53752541CA26892FA05A54F4626F4FED3418BD02B0E48EE60E899A2DD76DF73E` |

Forbidden-content scan: 0 tests, 0 coverage, 0 sandbox, 0 `.env`/`.local`, 0 credentials, 0 source maps, 0 `__mocks__`, 0 `.clinerules`, 0 `@cline/*`, 0 Cline runtime, 0 repository-engine (removed as dead code).

## Extension manifest

- `engines.vscode: "^1.100.0"`
- Entry: `dist/extension.js` (esbuild bundle)
- Publisher/license/repo fields: **USER INPUT REQUIRED** (not invented)

## Release status

Built for acquisition review only. **Not published, not installed.**
