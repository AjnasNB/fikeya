# Fikeya Delivery Plan

## Status definitions

- **Integrated beta candidate:** reachable through the current Desktop extension or `fikeya` CLI and covered by focused tests.
- **Standalone implemented:** tested component code exists, but it is not yet wired into the Desktop/CLI product path.
- **Partial:** a narrower behavior ships, while the complete item still has explicit gaps.
- **Planned:** the requirement is defined, but release evidence does not yet exist.

The presence of a standalone package does not make its behavior an integrated product feature.

Fikeya's primary outcome is provider-neutral AI-assisted development with better verified work per dollar. Context reduction is useful only when the same matched task remains externally verified; session continuity is a supporting runtime capability rather than the product's headline outcome.

## P0: Safe vertical slice

- Branded current Code OSS desktop: **partial** - a locally verified Windows beta candidate exists; signed cross-platform distributions are not released.
- Desktop and extension surface split: **integrated beta candidate** - Desktop retains the full native editor, terminal, source-control, and review surfaces while the VS Code extension exposes one focused Fikeya workspace.
- Python runtime and CLI: **integrated beta candidate** - initialization, diagnostics, providers, bounded model turns, the reviewed coding loop, cancellation, receipts, statistics, and tool-preset management are available.
- Typed local protocol: **partial** - runtime, Desktop, and sidecar validate bounded local messages, but the public TypeScript schema is not yet the one live contract consumed by every component.
- Provider profiles and secret references: **integrated beta candidate** - metadata remains separate from OS-keyring credential bytes.
- Azure Entra ID profile and execution: **integrated beta candidate** - the focused runtime path and a scoped connectivity receipt exist.
- Google Gemini profile and compatible execution: **integrated beta candidate**.
- Vertex AI compatible endpoint: **partial** - works with a short-lived bearer token; automatic ADC refresh is planned.
- Canonical workspace boundary: **partial** - runtime process working directories and sidecar roots are bounded; a complete typed file/patch broker is not implemented.
- One-use tool approvals: **integrated beta candidate** - Desktop and CLI receive exact file, search, edit, process, and test requests and bind each decision to the immutable request digest.
- Cancellation: **integrated beta candidate** for provider and reviewed coding turns, with standalone interop cancellation tests.
- Qarinah context, capture, and receipt adapter: **integrated beta candidate** - workspace initialization, bounded cited retrieval, content-free receipts, and completed-run capture are available.
- Qarinah graph in Desktop: **integrated beta candidate** - bounded local graph inspection is available without sample-data fallback.
- Local usage dashboard: **integrated beta candidate** - workspace SQLite aggregates provider-reported input, cached-input, output, context receipts, sessions, and provider/model activity.
- Transactional file patching and stale-diff rejection: **planned**.
- Disposable execution worktree fixture: **planned**.
- End-to-end Desktop/CLI parity fixture: **planned**.
- Windows targeted VSIX isolation check: **partial** - focused package checks exist; a complete clean-install desktop release gate remains open.

## P1: Agent interoperability and repository intelligence

- Native plan/act/observe/review core: **integrated beta candidate** - Desktop and CLI use the runtime adapter with approvals, root-bound tools, changed-file hashes, tests, cancellation, and execution receipts.
- Deep Agents and LangGraph integration: **planned** - the current native core does not require or bundle them.
- ACP client boundary: **standalone implemented** - local stdio session start/resume/fork, negotiation, cancellation, permissions, and bounded callbacks exist; product wiring and a native ACP agent remain planned.
- MCP client boundary: **standalone implemented** - discovery, allowlists, normalized calls, permission checks, limits, cancellation, and receipts exist; a product-level session manager, server, and registry remain planned.
- Codex app-server adapter: **standalone implemented** - local stdio contracts and the process manifest exist; Desktop/CLI wiring remains planned.
- Claude Agent SDK adapter: **planned**.
- Repository map, Tree-sitter symbols, LSP enrichment, and token-budget ranking: **planned**.
- Incremental indexing and stale-symbol removal: **planned**.
- Context compaction: **partial** - Qarinah provides bounded cited preparation/compaction; provider-backed optional summarization and an integrated product policy remain planned.
- Session resume and fork: **standalone implemented** in runtime/core state; integrated Desktop controls remain planned.
- Browser and crawler presets: **integrated alpha** as reviewed disabled configuration only.
- Browser and crawler tool sessions behind approvals: **planned** - MCP framing, execution-broker routing, and Desktop approval UX are not integrated.
- Patch checkpoints, rollback, lint, tests, and repair loop: **planned**.
- Linux and macOS clean-install evidence: **planned**.

## P2: Hardened ecosystem

- Signed tool marketplace and permission manifests: **planned**.
- Production sandbox backend: **planned**.
- Remote workspace adapter: **planned**.
- Multi-agent task graph and delegated worktrees: **planned**.
- Offline matched-receipt comparator: **standalone implemented** - it validates paired task conditions and computes solve rate, billed tokens, cost per verified task, and latency from completed receipts; it does not run agents or constitute product-performance evidence.
- Evaluation runner across provider and model profiles: **planned**.
- Cost and latency policy router: **planned**.
- Optional offline voice with a separately installed local model: **planned**.
- Accessibility and performance audit: **planned**.
- Reproducible signed Windows, macOS, and Linux packages: **planned**.
- SBOM, license gate, provenance, and update verification: **planned**.

## Release metrics

The target release evaluation optimizes cost per verified successful task rather than raw token reduction alone. It should record:

- task success and verification result;
- wall-clock time;
- provider input, cached-input, output, and reasoning tokens when reported;
- provider-reported or versioned calculated cost, clearly distinguished;
- context-pack size and cited-evidence coverage;
- tool retries, uncertain outcomes, and failed operations;
- user approvals and rejected actions; and
- verified recovery and workflow continuity after a runtime restart.

The current runtime records a narrower provider receipt: request/response hashes and byte counts, latency, status, provider/model identity, and provider-reported input/output/cache tokens or `unavailable`. The offline comparator can validate and aggregate completed benchmark receipts, but no integrated runner yet produces a matched product evaluation. Fikeya therefore does not claim the complete release evaluation above.

The Qarinah six-fixture estimate remains separate: 442,113 portable estimated baseline tokens versus 5,682 pack tokens, a 98.71% reduction. It is not provider billing, a task-quality result, or a universal product claim.
