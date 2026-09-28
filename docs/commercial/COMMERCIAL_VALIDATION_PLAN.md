# CodePilot AI — Commercial Validation Plan

## Target customers

- Software companies
- Engineering teams
- Startups with sensitive codebases
- Organizations experimenting with autonomous coding agents
- Companies with compliance/security requirements

## Interview questions

Investigate (do not lead toward predetermined answers):

1. How does your team currently use AI coding agents?
2. What security concerns do you have about autonomous code execution?
3. What approval requirements do you need for AI-driven file/terminal changes?
4. Do you use MCP or external tool integrations?
5. How do you protect repositories from unauthorized access?
6. What terminal/tool permissions are acceptable for an AI agent?
7. What audit/compliance records do you need?
8. What are your deployment constraints (cloud vs local vs air-gapped)?
9. What do you currently pay for AI coding tools?
10. What would make you switch from your current alternative?

## Pilot hypothesis

A small paid pilot around: **controlled autonomous coding + approval + security + auditability**.

The pilot tests whether teams will pay for an agent that:
- Executes autonomously but gates risky operations behind explicit approvals.
- Enforces workspace, terminal, browser, and MCP boundaries.
- Produces a complete audit trail (approvals, tool calls, usage/cost).

## Pricing (hypothesis — must be tested)

Pricing is a hypothesis to be validated, not a market-tested fact. Candidate models to test:
- Per-seat SaaS subscription.
- Per-organization license with audit features.
- One-time enterprise license + support.

Do not invent a price as if it were market validated.

## Validation gates

1. **Technical** — 2547/2547 tests, security suites, browser E2E, MCP (all PASS).
2. **Security review** — M4, SSRF, redaction, boundaries (all verified).
3. **Pilot** — 2-4 target customers run a controlled pilot; measure approval usage, audit value, and willingness to pay.
4. **Commercial** — pricing validated by pilot feedback; no revenue claimed before pilot.

## Success criteria

- Pilot customers approve the security model.
- Pilot customers use the approval workflow (not bypass it).
- Pilot customers express willingness to pay a validated price.
- No security regression during pilot.
