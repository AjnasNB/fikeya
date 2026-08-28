# Fikeya Security Model

## Status and scope

Fikeya 0.1.0-beta.4 is the current public-beta source candidate. This document distinguishes:

- **Current enforcement:** behavior enforced in the integrated Desktop/runtime path today.
- **Standalone enforcement:** behavior implemented and tested in a component that is not yet wired into the product path.
- **Target requirement:** a security property required before the complete architecture can be called stable.

Model output, repository content, web content, plugins, MCP servers, ACP agents, and imported histories are always untrusted.

## Current integrated enforcement

### Credentials

- Runtime credentials enter through a hidden prompt or standard input and are stored in the operating-system credential store.
- The Desktop sends newly entered provider credentials to the runtime over child-process standard input; it does not place them in command arguments, webview HTML, ordinary extension state, or logs.
- Azure Microsoft Entra ID is preferred where supported; no Azure access token is persisted by Fikeya.
- Config files contain non-secret metadata and opaque secret references only.
- Provider connectivity diagnostics omit authorization headers, response bodies, and credential bytes.

### Workspace and process boundary

- Workspace initialization binds runtime state to one canonical root.
- The integrated broker exposes bounded file listing, UTF-8 reads, literal search, hash-guarded replace/write operations, and one allowlisted process invocation. It accepts an executable and argument array, never a raw shell string.
- Real process execution starts disabled and additionally requires an executable allowlist, an in-root working directory, and a short-lived one-use approval matching the exact canonical request.
- Changing an argument, working directory, environment key, or request digest invalidates that approval.
- Command interpreters, sensitive command arguments, sensitive environment names, unsafe inherited environment variables, and invalid timeouts are rejected by the broker boundary.

The integrated runtime provides canonical workspace file operations with SHA-256 preconditions and atomic replacement. Approved processes are scanned before and after execution so created, modified, and deleted project files enter the run receipt. It does **not** yet provide transactional multi-file patch staging, filesystem rollback, disposable-worktree creation, or a complete sandbox boundary.

### Provider network boundary

- Model execution requires explicit `--allow-network` consent.
- Provider endpoints are validated; remote endpoints require HTTPS and loopback local providers may use HTTP.
- Provider HTTP responses, redirects, timeouts, and response sizes are bounded.
- Ordinary configuration and tests do not contact a provider unless the user explicitly invokes a network operation.

### Browser and crawler preset boundary

Browser and crawler presets are configuration only. They start disabled, are bound to the exact reviewed manifest digest when enabled, and do not start a child merely by being listed or enabled.

The preset loader uses a fixed executable without a shell, a minimal environment, root-bound metadata, and bounded request/response/session limits. Complete MCP framing, upstream robots/redirect/network policy, provenance verification, and forced child termination on protocol failure remain caller responsibilities.

### Memory and privacy boundary

Qarinah retrieval is opt-in per workspace. The runtime invokes the Qarinah CLI with an argument vector and stores only content-free response metadata such as byte length, duration, status, evidence count, coverage, and SHA-256 digest. Prompt, context, and provider-output bodies are not written to runtime SQLite.

The Qarinah sidecar is root-bound, imposes request-size and response-shape limits, and does not execute tools or manage secrets.

### Current receipts

The integrated provider path records request and response hashes, byte counts, latency, status, provider/model identifiers, and exact provider-reported input/output/cache tokens when present. Missing usage is recorded as `unavailable`; it is not estimated.

This is not yet a complete record of patches, affected paths, tests, sandbox identity, or tool outcomes because the full agent-core/execution-broker path is not integrated.

## Standalone component enforcement

### Agent Core

The standalone Agent Core binds each approval to request ID, session, tool, canonical argument digest, and checkpoint revision. Durable exact-call grants, per-session execution leases, broker call-ID deduplication, bounded retries, explicit uncertain/reconciliation states, durable event replay, cancellation, and pending-approval re-emission are tested at the component boundary.

The core exposes only an injected execution-broker interface. It does not itself grant filesystem, shell, sandbox, or network isolation.

### ACP, Codex, and MCP interop

The standalone interop gateway enforces root-bound shell-free stdio process specifications, command/environment allowlists, capability negotiation, cancellation, permission callbacks, bounded payloads, MCP tool allowlists, result/resource limits, and content-free receipts.

It is not a sandbox or credential broker. An allowlisted child retains the operating-system permissions of the current user unless an external execution broker or OS sandbox restricts it. Remote ACP, MCP, and Codex WebSocket transports are excluded from the current beta.

### Protocol schemas

Public TypeScript protocol schemas are a compatibility target. The current Desktop and Python runtime still validate their own live boundary models; repository presence of a schema must not be treated as proof that every component already conforms to it.

## Target security requirements

### Complete file and worktree boundary

Every file operation must resolve the workspace root and target to canonical absolute paths and reject traversal, absolute-path injection, unsupported UNC/device paths, scheme changes, symlink escapes, and writes outside the selected worktree.

File replacement must be transactional: stage a patch, validate its expected context, present the diff, and write only after approval. Rejecting or invalidating a proposal must leave the worktree byte-for-byte unchanged.

### Complete command and sandbox boundary

Privileged commands must continue to use an executable and argument array with an exact working directory, timeout, and resource limits. High-risk operations require a separately reviewed sandbox policy. Command chaining, hidden shells, unsafe environment inheritance, background detachment, and privilege changes must remain denied unless a dedicated typed operation explicitly allows them.

### Complete network boundary

Tools must declare allowed hosts, methods, redirects, request sizes, response sizes, and timeouts. Browser and crawler content must not be able to invoke tools or alter policy. Remote MCP/ACP support, if added, requires authentication, trust establishment, revocation, and downgrade protection.

### Plugin and marketplace boundary

A future plugin or marketplace package must declare its identifier, version, content hash, capabilities, license metadata, and signature or explicit local-trust decision. Unreviewed directories must not be auto-loaded. High-risk plugins require a sandboxed process with minimal filesystem and network policy.

No general signed-plugin marketplace or production sandbox is claimed by the current beta.

### Complete evidence

After execution, the integrated product must record the operation identifier, exact approval, exit status, affected paths, patch/output hashes, verification results, sandbox identity, provider usage, and related Qarinah references. A pre-execution approval must never be presented as evidence that execution succeeded.

## Approval defaults for the target integrated product

| Class | Target default | Examples |
| --- | --- | --- |
| Read | Allow inside workspace | read file, list symbols, search |
| Proposed write | Ask | patch, create file, format |
| Process | Ask | test, build, package manager |
| Destructive | Deny, then explicit override | delete, force push, database reset |
| Network | Ask per host or trusted scope | provider, MCP, browser, crawler |
| Secret | Never disclose to model | key retrieval and credential injection |

These defaults describe the target policy model. They are not evidence that every operation class has an integrated broker today.

## Security release gates

Before a stable release, tests must cover:

- traversal, UNC/device-path, and symlink escape;
- rejected writes and stale-diff rejection;
- shell metacharacter and argument confusion;
- environment and authorization-header redaction;
- cancellation, timeout, disconnect, and uncertain execution;
- malformed protocol messages and oversized payloads;
- provider failure and partial-stream recovery where streaming exists;
- sidecar restart and idempotent replay;
- MCP/ACP capability downgrade;
- browser redirect and crawler boundary escape; and
- extension/plugin manifest and hash failure.

Passing focused component tests does not satisfy this gate until the integrated Desktop/CLI path exercises the same boundaries on supported platforms.

## Vulnerability reporting

Do not open a public issue for a suspected vulnerability. Until a dedicated private channel is published, use the repository security-advisory workflow.
