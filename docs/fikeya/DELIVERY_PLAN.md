# Fikeya Delivery Plan

Status legend: **implemented** means tested code exists on this branch, **in progress** means code is being integrated, and **planned** means the contract is defined but release evidence does not yet exist.

## P0: Safe Vertical Slice

- Branded current Code OSS desktop: in progress
- Fikeya built-in extension and two layouts: in progress
- Four-mode selector: in progress
- Python runtime and CLI: in progress
- Typed stdio protocol: in progress
- Provider profiles and secret references: in progress
- Azure Entra ID profile: in progress
- Canonical workspace boundary: in progress
- Structured read, search, patch, test, and command tools: in progress
- One-use approvals and cancellation: in progress
- Qarinah status, context, event, and receipt adapter: in progress
- Disposable worktree fixture: planned
- Desktop and CLI parity fixture: planned
- Windows clean-install evidence: planned

## P1: Agent Interoperability and Repository Intelligence

- Native planning and subagents through Deep Agents and LangGraph: planned
- ACP client and native ACP agent: planned
- MCP client, server, tool registry, and capability approval: planned
- Codex App Server adapter: planned
- Claude Agent SDK adapter: planned
- Repository map, Tree-sitter symbols, LSP enrichment, and token-budget ranking: planned
- Incremental indexing and stale-symbol removal: planned
- Context compaction with provider-backed optional summarization: planned
- Session resume and fork: planned
- Browser and crawler permissioned tools: planned
- Patch checkpoints, rollback, lint, tests, and repair loop: planned
- Linux and macOS clean-install evidence: planned

## P2: Hardened Ecosystem

- Signed tool marketplace and permission manifests: planned
- OpenShell-compatible sandbox backend: planned
- Remote workspace adapter: planned
- Multi-agent task graph and delegated worktrees: planned
- Evaluation harness across provider and model profiles: planned
- Cost and latency policy router: planned
- Optional offline voice with a separately installed local model: planned
- Accessibility and performance audit: planned
- Reproducible signed Windows, macOS, and Linux packages: planned
- SBOM, license gate, provenance, and update verification: planned

## Release Metrics

Fikeya optimizes cost per verified successful task, not raw token reduction alone. A release evaluation records:

- Task success and verification result
- Wall-clock time
- Provider input, cached-input, output, and reasoning tokens
- Provider-reported or versioned calculated cost
- Context-pack size and cited evidence coverage
- Tool retries and failed operations
- User approvals and rejected actions
- Fresh-session reconstruction success

The Qarinah six-fixture estimate remains separate: 442,113 portable estimated baseline tokens versus 5,682 pack tokens, a 98.71% reduction. It is not a universal provider-billing claim.

