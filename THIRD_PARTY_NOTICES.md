# Third-Party Notices

CodePilot AI incorporates the following third-party software. This file records
the license facts we could **verify from the distributed artifacts**; where a
package omits license metadata we say so explicitly rather than guessing.

## Cline SDK (`@cline/*`) — historical dependency, removed

Earlier revisions of CodePilot AI's agent runtime were built on the Cline SDK
packages published by the Cline project. **As of the current tree, no
`@cline/*` package is a dependency (production or development), none is
installed, none appears in the lockfile, and none ships in `dist/` or the
VSIX.** The table below is retained as a historical record of what was used
and where — not as a current dependency declaration.

| Package | Last used version | Formerly used by | `license` field (then) | LICENSE file in package (then) |
|---|---|---|---|---|
| `@cline/core` | 0.0.75 | `@codepilot/agent-runtime`, `apps/vscode-extension` | **none declared** | **not shipped** |
| `@cline/agents` | 0.0.75 | `@codepilot/agent-runtime`, `@codepilot/tool-engine` | `Apache-2.0` | **not shipped** |
| `@cline/llms` | 0.0.75 | `@codepilot/model-gateway`, `@codepilot/agent-runtime` | **none declared** | **not shipped** |
| `@cline/shared` | 0.0.75 | `@codepilot/model-gateway`, `@codepilot/policy-engine`, `@codepilot/tool-engine` | **none declared** | **not shipped** |

### Source of license terms

The npm tarballs for `@cline/core`, `@cline/llms` and `@cline/shared` ship
neither a `license` field in `package.json` nor a `LICENSE` file, so their
license cannot be confirmed from the artifacts alone. However:

- All five packages' `package.json` `repository` fields point to the same
  monorepo: `https://github.com/cline/cline` (directories
  `sdk/packages/{core,agents,llms,shared}`).
- The root `LICENSE` of that repository is the **Apache License 2.0** (verified
  against the repository's `main` branch at the time of this writing).
- `@cline/agents` and `@cline/sdk` declare `"license": "Apache-2.0"` in their
  own metadata, consistent with the monorepo license.

**Working assumption:** the SDK packages are distributed under Apache-2.0 by
their author. The missing metadata on three packages is an upstream packaging
gap, not evidence of a proprietary license.

### Apache-2.0 attribution

Portions of this software are derived from the Cline SDK
(https://github.com/cline/cline), licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0).

Apache-2.0 requires that derivative distributions include a copy of the license
and carry required notices. Because the upstream npm tarballs omit the license
text, a copy of the Apache License 2.0 must accompany any redistribution of
CodePilot AI that includes these packages (the canonical text is available at
the URL above).

**Action item before general distribution:** confirm the license directly with
the Cline project (or via their repository's LICENSE files for the exact
published revision) rather than relying solely on this working assumption.

## Model catalogue data (curated in-repo catalogue)

The provider/model catalogue shown in the UI and CLI is CodePilot's own
curated registry (`CODEPILOT_PROVIDER_CATALOG` in `@codepilot/llm`) with a
status/category/usage overlay in `@codepilot/model-gateway`. Earlier
revisions consumed a static registry embedded in `@cline/llms` whose
provider descriptions identified the data source as **models.dev**
(https://models.dev); that SDK path no longer ships. Where curated static
model entries carry pricing or capability facts, they are maintained
in-repo; live model discovery (Ollama `/api/tags`, OpenAI-compatible
`/models`) is authoritative at runtime whenever reachable.

## Other dependencies

All other dependencies are consumed per their declared licenses via the
standard package manifests and are not special-cased here. API keys and user
credentials are never included in this distribution.

## Currently shipped third-party runtime components (VSIX)

Verified from the packaged archive and installed manifests:

| Component | License (declared) | Role |
|---|---|---|
| `@modelcontextprotocol/sdk` 1.x (MIT) | MIT | MCP client protocol for MCP server tools |
| `playwright-core` (Apache-2.0) | Apache-2.0 | Browser automation backing the browser tools |
| All `@codepilot/*` workspace packages | Apache-2.0 (repo `LICENSE`) | First-party CodePilot code (not third-party; listed for completeness) |
