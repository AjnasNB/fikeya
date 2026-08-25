# Fikeya Architecture

Fikeya is an AI code editor and coding-agent runtime first. Durable sessions and Qarinah-backed context are supporting mechanisms, not the product definition. The architecture is optimized around bounded context selection, provider choice, visible tool control, external task verification, and exact usage receipts so efficiency can be measured as verified work per dollar.

## Status and reading guide

Fikeya is a beta candidate. This document separates three different kinds of behavior:

- **Integrated now** is reachable through the current Desktop extension or `fikeya` CLI.
- **Standalone component** has focused tests in this repository but is not yet connected to the Desktop/CLI product path.
- **Target requirement** defines the intended architecture and is not a statement that the behavior ships today.

Only the first category should be treated as current end-user behavior.

## Integrated beta-candidate behavior

### Desktop

Fikeya Desktop is a branded Code OSS workbench with the existing editor, terminal, source-control, debugging, task, language-service, and extension-host surfaces. The built-in Fikeya extension adds one focused coding-agent workspace rather than duplicating those native surfaces. The same extension can be packaged as a VSIX for VS Code-compatible hosts.

- **Editor** is the native workbench editor and its language services.
  - **Agent** exposes provider selection, Qarinah context controls, the reviewed coding loop, exact approvals, cancellation, outcomes, and receipts.
  - **Lab** opens the same verified provider, usage, and graph surface for controlled model experiments without duplicating the editor inside the extension.
- **Terminal** is the native integrated terminal; agent-requested processes remain separate approval-gated operations.
- **Review** uses native source control plus the Fikeya execution and evidence receipts.

The Agent surface requires fresh network consent for every run. It receives output after the provider turn completes; token-delta streaming is not implemented. Each file, search, edit, or process tool request pauses for a request-bound allow-once, deny-once, or cancel decision. Approved arguments cannot be mutated or reused.

The Studio layout can display a bounded, searchable Qarinah graph from the pinned local sidecar. Search, filters, node movement, pan, and zoom are local UI behavior. The graph reports unavailable data instead of substituting samples.

### Python runtime and CLI

The current runtime provides:

- workspace initialization and diagnostics;
- provider-profile metadata backed by the operating-system credential store;
- explicit provider connectivity tests;
- one bounded model turn after `--allow-network`;
- cooperative cancellation and resumable/forkable SQLite session primitives;
- provider-reported usage or an explicit `unavailable` measurement;
- content-free provider and Qarinah receipts; and
- a process-only `ToolBroker` that accepts an executable and argument vector, starts disabled, and requires an exact one-use approval before real execution.

Azure OpenAI and OpenAI use the Responses API by default. Anthropic uses its native Messages API. OpenRouter, NVIDIA NIM, Google Gemini, Hugging Face Inference Providers, Groq, Ollama, and generic OpenAI-compatible profiles use compatible HTTP execution. Vertex AI is available through the compatible profile with a regional endpoint and a short-lived Google Cloud token; automatic ADC refresh remains a release follow-up. Every network turn still requires explicit consent, and credential bytes remain in the operating-system vault or an ephemeral identity token. HTTP quota failures are classified without retaining the provider body so the Desktop can offer a person-controlled handoff to another configured profile while retrieving the same workspace context again.

### Qarinah context-engine boundary

The runtime can invoke a separately installed `qarinah` executable with an argument vector and `shell=False` to compile opt-in cited context under a selected budget. Durable runtime state retains content-free metadata rather than prompt or context bodies.

The pinned Node.js sidecar provides a root-bound `MemoryPort` for status, record, prepare, compact, inspect, receipts, worktrees, cancellation, and close operations. It executes no tools and manages no provider credentials.

```ts
interface FikeyaMemoryPort {
	open(input: { root: string; capture?: 'metadata' | 'content'; allowQuery?: boolean }): Promise<object>;
	status(): Promise<object>;
	record(event: object): Promise<object>;
	prepare(input: { query: string; maxTokens: number; scopes?: string[] }): Promise<object>;
	compact(input: { query: string; maxTokens?: number; record?: boolean }): Promise<object>;
	inspect(input?: { query?: string; includeWorktrees?: boolean }): Promise<object>;
	receipts(input?: { sessionId?: string; query?: string }): Promise<object>;
	worktrees(): Promise<object[]>;
	cancel(requestId: string): void;
	close(): Promise<void>;
}
```

### Browser and crawler presets

The runtime ships reviewed, disabled-by-default configuration presets for separately installed Cockroach Browser and Cockroach Crawler executables. Enabling a preset records an exact manifest digest for one workspace; it does not start the tool.

The current runtime does not provide the complete MCP framing/session loop or a Desktop approval flow for these tools. The caller remains responsible for protocol framing, cancellation, upstream network policy, and child termination.

## Tested standalone components

These components have focused tests but are not yet one integrated Desktop/CLI execution path:

- **Fikeya Agent Core** also remains usable as a standalone package. Its plan, act, observe, and review state machine is integrated into `fikeya agent execute` with root-bound file, search, edit, process, test, approval, changed-file, and outcome adapters. LangGraph and Deep Agents are not required or bundled in the current core.
- **Fikeya Interop** implements bounded local-stdio adapters for ACP agents, Codex app-server, and MCP tools. It includes capability and permission boundaries, cancellation, allowlists, result limits, and content-free receipts. It is neither a sandbox nor a credential broker and is not yet wired into Desktop or the runtime CLI.
- **Fikeya Protocol** contains public TypeScript schemas intended to become a shared compatibility surface. The Desktop and Python runtime still maintain their own live boundary models, so conformance between all components is not yet a shipped guarantee.

## Target architecture requirements

The following sections preserve the intended complete product architecture. They are release requirements, not claims about the current alpha.

### Target Desktop experience

- **Editor** should support completion, explanation, targeted transforms, and selected-context chat while autonomous shell tools remain disabled.
- **Agent** should present plans, tool proposals, approval checkpoints, patches, tests, and evidence from the integrated agent core.
- **Terminal** should keep the exact executable, argument array, working directory, and approval visible for command-oriented work.
- **Review** should be read-only by default, with fixes retained as proposals until accepted.
- **Studio** should remain code-first; **Agent Focus** should make plan, conversation, evidence, and artifacts lead while allowing the explorer to collapse.

### Target local gateway

Desktop and CLI should use one root-bound local gateway over stdio. It should own:

- version and capability negotiation;
- typed request, response, notification, cancellation, resume, and fork messages;
- workspace-root binding;
- secret-reference resolution;
- backpressure and bounded payloads; and
- runtime lifecycle and restart recovery.

No unauthenticated local HTTP listener should be part of the default architecture.

### Target runtime orchestration

The integrated runtime should own model routing, planning, sessions, bounded context compilation, tool orchestration, usage accounting, and adapter lifecycles. Desktop and CLI should consume the same events and receipts.

The standalone native core can become the default planner. Optional LangGraph or Deep Agents integrations must remain behind Fikeya-owned interfaces. Complete external agents should connect through ACP; Codex through its local app-server; Claude through an official SDK with user-provided API credentials; and individual tools and resources through MCP.

### Target execution broker

Privileged operations must remain outside the model process. The complete broker should accept structured operations rather than arbitrary model-generated shell strings. Every operation should bind:

- the exact workspace and optional disposable-worktree identity;
- canonical path and symlink resolution;
- executable plus argument array, or a typed file operation;
- permission class and exact one-use approval identifier;
- timeout, output, file-count, and resource limits;
- cancellation and idempotency identifiers; and
- exit status, affected paths, and evidence hashes.

A future file broker must stage patches transactionally, validate stale context, show the proposed diff, and leave the worktree unchanged when rejected. That file/patch broker is not part of the current runtime slice.

### Target browser and crawler execution

Browser and crawler integrations should run as permissioned tools behind the execution broker. They must not load merely because a workspace opens.

- Browser automation should use a dedicated process and explicit host/domain policy.
- The crawler should receive explicit starting URLs, boundaries, budgets, and output schemas.
- External page content must remain untrusted data and cannot override system or workspace policy.
- Captured outputs should be hashed before Qarinah records their references.

### Target provider layer

The provider layer should add capability negotiation, cancellation-aware streaming where supported, tool-call normalization, and consistent usage receipts. A provider profile must contain only non-secret routing information plus a keychain reference.

Provider-reported token counts and locally calculated estimates must remain distinguishable. No estimate may be displayed as provider billing.

### Target run flow

1. Desktop or CLI binds a canonical workspace root.
2. The gateway starts or reconnects the runtime and Qarinah sidecar.
3. Qarinah verifies workspace policy and ledger state.
4. The runtime creates or resumes a session.
5. Context preparation compiles a cited pack under the selected budget.
6. The provider produces bounded model events using its declared capabilities.
7. Proposed tools become structured approval requests.
8. Approved tools run through the broker or an external sandbox.
9. Result hashes, exit status, affected paths, tests, and provider usage become receipts.
10. The runtime evaluates completion and either continues, asks the user, or ends the turn.
11. Qarinah compacts derived context while retaining authoritative evidence.

Steps 6 through 10 are not yet connected end to end in the current Desktop/CLI path.

## Storage

Current workspace initialization creates `.fikeya/workspace.json` and `.fikeya/state.sqlite3` plus SQLite journal files as needed. Qarinah owns its separately initialized local state.

The target integrated layout is:

```text
workspace/
  .fikeya/
    workspace.json       non-secret identity and policy
    state.sqlite3        sessions, events, approvals, usage, receipts
    worktrees/           target: disposable execution worktrees
    artifacts/           target: bounded outputs addressed by hash
    qarinah/             target: explicitly managed Qarinah state boundary
```

Secrets must not live in this directory. They belong in the operating-system credential store, VS Code SecretStorage where a Desktop-only credential is required, Azure workload identity, or a future enterprise KMS.

## Optional team control

Tenant billing, SSO, SCIM, and enterprise administration are not part of the public runtime. A future optional control plane may distribute policy, identity, model allowlists, budgets, and revocations, while endpoints continue to enforce local offline-expiry rules.

## Release gate

Fikeya must not be described as stable until the same fixture succeeds through Desktop and CLI, rejected operations leave the worktree unchanged, cancellation terminates active work, recovery survives sidecar/runtime restart, secrets are absent from artifacts, and clean-install tests pass on Windows, macOS, and Linux.
