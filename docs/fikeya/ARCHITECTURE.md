# Fikeya Architecture

## Objective

Fikeya provides one coding-agent runtime through Desktop and CLI. Both interfaces must produce the same plan events, permission requests, tool results, usage receipts, context receipts, patches, and verification evidence.

The product is local-first. A future team control plane is optional and cannot silently broaden local permissions.

## Components

### Desktop

The desktop is a current Code OSS distribution with a built-in Fikeya extension. It contributes four modes and two layouts without replacing the editor, terminal, source control, debugging, or extension host.

- **Editor:** completion, explanation, targeted transforms, and selected-context chat. Autonomous shell tools are disabled.
- **Agent:** plans, tool proposals, approval checkpoints, patches, tests, and evidence.
- **Terminal:** command-oriented work with explicit executable and argument visibility.
- **Review:** read-only analysis by default. Fixes remain proposals until accepted.
- **Studio layout:** explorer and editor lead; the agent and approvals stay compact.
- **Agent Focus layout:** plan, conversation, evidence, and artifacts lead; the explorer can collapse.

### Local Gateway

The desktop spawns one gateway per exact workspace root over stdio. The gateway is the only bridge between UI events and the Python runtime.

Responsibilities:

- Version and capability negotiation
- Typed request, response, notification, cancellation, resume, and fork messages
- Workspace-root binding
- Secret-reference resolution
- Backpressure and bounded payloads
- Runtime lifecycle and restart recovery

No unauthenticated local HTTP listener is part of the default architecture.

### Python Runtime

The runtime owns model routing, planning, sessions, context budgets, tool orchestration, usage accounting, and adapter lifecycles. Desktop and CLI both call this runtime.

The native planner can use Deep Agents and LangGraph behind Fikeya-owned interfaces. Complete external agents connect through ACP. Codex connects through its local App Server. Claude connects through the Agent SDK with user-provided API credentials. MCP connects agents to individual tools and resources.

### Execution Broker

Privileged operations remain outside the model process. The broker accepts structured operations, never arbitrary model-generated shell strings.

Every operation includes:

- Exact workspace and optional disposable worktree identity
- Canonical path and symlink resolution
- Executable plus an argument array
- Permission class and one-use approval identifier
- Timeout, output, and file-count limits
- Cancellation identifier
- Exit status and evidence hashes

### Qarinah Memory Sidecar

Qarinah runs as a pinned Node.js sidecar behind a typed `MemoryPort`. It records evidence-linked lifecycle events and compiles bounded cited context. It does not execute tools or manage secrets.

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

Fikeya records session, prompt, model, context, approval, tool, artifact, decision, summary, compaction, turn, and session-end events. Deterministic event identifiers make retries idempotent.

### Browser and Crawler

Browser and crawler integrations are permissioned tools behind the broker. They are not loaded merely because a workspace opens.

- Browser automation uses a dedicated process and an explicit host/domain policy.
- The crawler receives explicit starting URLs, boundaries, budgets, and output schemas.
- External page content is treated as untrusted data and cannot override system or workspace policy.
- Captured outputs are hashed before their references are recorded in Qarinah.

### Provider Layer

Profiles support Azure OpenAI, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Ollama, and generic OpenAI-compatible endpoints. A provider profile contains non-secret routing information plus a keychain reference.

Azure uses Microsoft Entra ID by default where supported. API-key authentication remains an explicit alternative. The runtime records provider-returned input, cached-input, output, and reasoning token counts when available. Estimates are labeled as estimates and never displayed as provider billing.

## Run Flow

1. Desktop or CLI binds a canonical workspace root.
2. The gateway starts the runtime and Qarinah sidecar.
3. Qarinah verifies workspace policy and ledger state.
4. The runtime creates or resumes a session.
5. Context preparation compiles a cited pack under the selected token budget.
6. The provider streams model events.
7. Proposed tools become structured approval requests.
8. Approved tools run in the broker or sandbox.
9. Result hashes, exit status, patch, tests, and provider usage become receipts.
10. The runtime evaluates completion and either continues, asks the user, or ends the turn.
11. Qarinah compacts durable facts without discarding authoritative evidence.

## Storage

```text
workspace/
  .fikeya/
    workspace.json       non-secret identity and policy
    state.sqlite         sessions, events, approvals, usage, receipts
    worktrees/           disposable execution worktrees
    artifacts/           bounded outputs addressed by hash
    qarinah/             Qarinah-owned local state
```

Secrets never live in this directory. They remain in VS Code SecretStorage, the operating-system keychain, Azure managed identity, or a future enterprise KMS.

## Optional Team Control

The optional private enterprise plane can distribute policy, identity, model allowlists, budgets, and revocations. Endpoints continue to enforce local offline-expiry rules. The public runtime does not embed tenant billing, SSO, SCIM, or administrative data.

## Release Gate

A Fikeya release is not stable until the same fixture succeeds through Desktop and CLI, a rejected operation leaves the worktree unchanged, a cancelled operation terminates, the run survives a sidecar restart, secrets are absent from artifacts, and clean-install tests pass on Windows, macOS, and Linux.

