# Fikeya Security Model

## Trust Boundaries

Fikeya separates six principals: the user interface, local gateway, model runtime, execution broker, memory sidecar, and external provider. Model output, repository content, web content, plugins, MCP servers, and imported histories are untrusted.

## Credentials

- Desktop credentials use VS Code SecretStorage.
- CLI credentials use the operating-system credential store.
- Azure Microsoft Entra ID is preferred over static keys.
- Config files store opaque secret references only.
- Secrets are never written to prompts, ledgers, Qarinah content, logs, screenshots, fixtures, crash reports, or Git.
- Provider tests redact authorization headers and response bodies before recording diagnostics.

## Workspace Boundary

Every file operation resolves the workspace root and target to canonical absolute paths. It rejects traversal, absolute-path injection, UNC and device paths where unsupported, scheme changes, symlink escapes, and writes outside the selected worktree.

File replacement is transactional. The broker stages a patch, validates context, presents the diff, and writes only after approval. Rejecting a proposal leaves the worktree byte-for-byte unchanged.

## Command Boundary

The runtime cannot send a raw shell command. It sends an executable and argument array with a working directory, timeout, and resource limits. The broker displays those exact fields before one-use approval. Command chaining, hidden shells, inherited unsafe environment variables, and background detachment require separate policy.

## Network Boundary

Provider profiles declare their endpoint. Tools declare allowed hosts, methods, redirects, request sizes, response sizes, and timeouts. Browser and crawler content cannot issue tools. Remote MCP and ACP connections require authentication and explicit trust.

## Plugin Boundary

Plugins are not loaded from an unreviewed directory. A plugin requires a manifest, version, hash, declared capabilities, license metadata, and signature or explicit local trust. High-risk plugins run in a sandboxed process with a minimal filesystem and network policy.

## Memory and Privacy

Qarinah capture is opt-in and scoped per workspace. Metadata mode records coarse lifecycle data. Content mode records bounded, redacted fields. The authoritative ledger is hash chained; derived views can be rebuilt. Provider usage receipts store counts and identifiers, not prompt text, unless the workspace explicitly enables content capture.

## Approval Classes

| Class | Default | Examples |
| --- | --- | --- |
| Read | Allow inside workspace | read file, list symbols, search |
| Proposed write | Ask | patch, create file, format |
| Process | Ask | test, build, package manager |
| Destructive | Deny then explicit override | delete, force push, database reset |
| Network | Ask per host or trusted scope | provider, MCP, browser, crawler |
| Secret | Never disclose to model | key retrieval and credential injection |

## Evidence

After execution, Fikeya records the operation identifier, approval, exit status, affected paths, patch hash, output digest, test result, sandbox identity, provider usage, and related Qarinah event references. A pre-execution approval is not presented as proof that a command succeeded.

## Required Security Tests

- Traversal, UNC, device-path, and symlink escape
- Rejected writes and stale-diff rejection
- Shell metacharacter and argument confusion
- Environment and authorization-header redaction
- Cancellation and timeout
- Malformed protocol messages and oversized payloads
- Provider failure and partial stream recovery
- Sidecar restart and idempotent replay
- MCP/ACP capability downgrade
- Browser redirect and crawler boundary escape
- Extension/plugin manifest and hash failure

## Vulnerability Reporting

Do not open a public issue for a suspected vulnerability. A private reporting channel will be published before the first stable release. Until then, use the repository security-advisory workflow.

