# Fikeya interoperability gateway

This alpha package gives Fikeya one bounded interface for local coding agents and tools:

- Agent Client Protocol (ACP) agents through the official `agent-client-protocol` Python SDK.
- Codex app-server through its stable local JSONL stdio protocol.
- Model Context Protocol (MCP) servers through the official MCP Python SDK v2.

It is a protocol boundary, not a sandbox and not a credential broker. Child processes still run with the operating-system
permissions of the Fikeya user. Production deployments must place untrusted agents and MCP servers inside Fikeya's separate
execution broker or another operating-system sandbox.

## What works

- Shell-free, allowlisted stdio process startup with a root-bound working directory.
- ACP capability negotiation, new/resume/fork session contracts, prompts, cancellation, permission callbacks, and bounded file
  callbacks.
- Codex initialize/initialized handshake, thread start/resume/fork, turn start/interruption, server-initiated command and file
  approvals, and scoped permission responses.
- MCP paginated tool discovery, qualified tool allowlists, side-effect approval, normalized tool results, byte/resource limits,
  cancellation, and content-free receipts.
- JSON manifests that contain process metadata only. API keys, bearer tokens, cookies, and subscription credentials are rejected
  at the process-policy boundary.

## Install and verify

```bash
cd integrations/fikeya-interop
uv sync --extra test
uv run ruff check src tests
uv run pytest
```

The lockfile pins ACP `0.12.1` and MCP `2.0.0`. Upgrading either protocol requires updating the adapters and deterministic tests
together.

## Use a manifest

`manifests/codex-app-server.json` starts the user's locally installed `codex app-server`. Fikeya does not read, copy, or relay a
ChatGPT/Codex subscription credential. Authentication remains owned by the installed Codex client.

`manifests/generic-acp.example.json` and `manifests/generic-mcp.example.json` are templates. The parent application must:

1. Load the manifest with `load_manifest`.
2. Construct a `ProcessPolicy` with an explicit command and environment allowlist.
3. For MCP, construct a `ToolPolicy`; an empty allowlist denies every tool.
4. Provide a permission resolver connected to a visible user approval surface.
5. Place untrusted children inside the execution broker before treating them as isolated.

## Protocol sources

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Agent Client Protocol Python SDK](https://agentclientprotocol.github.io/python-sdk/)
- [MCP Python SDK](https://py.sdk.modelcontextprotocol.io/)

These projects define the wire protocols. Fikeya's models, policies, normalization, and receipts remain its own compatibility
surface so callers do not depend directly on upstream SDK objects.

## Current limits

- Local stdio only. Remote ACP, MCP, and Codex WebSocket transports are intentionally excluded from this alpha.
- ACP terminal callbacks are disabled. Commands must route through Fikeya's execution broker.
- MCP annotations are untrusted hints. A tool is treated as side-effecting unless it explicitly marks itself read-only, and the
  allowlist still applies.
- The gateway returns bounded content to the active caller, but receipts retain only digests, byte counts, status, and duration.
- An allowlisted child can access anything granted to the operating-system user unless an external sandbox prevents it.
