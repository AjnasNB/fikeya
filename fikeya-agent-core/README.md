# Fikeya Agent Core

Fikeya Agent Core is the first native, provider-neutral coding-agent orchestration slice for Fikeya. It advances a durable
session through `plan -> act -> observe -> review`, pauses every proposed tool call for an explicit approval, and delegates all
execution to an injected broker.

This is an alpha orchestration kernel. It is not a complete IDE agent and does not claim feature parity with Claude Code,
Codex, Cursor, Deep Agents, or any other agent product.

## Implemented

- A typed plan, act, observe, and review state machine with terminal completed, cancelled, and failed states.
- Resumable, optimistic JSON checkpoints using an in-memory store or durable SQLite. Pickle is never used.
- Typed async streaming events with monotonic per-session sequences.
- Explicit approval requests that expose bounded tool arguments to the approval surface before execution.
- Cooperative cancellation, provider and broker timeouts, bounded retries, step limits, context limits, and output limits.
- An injected `ExecutionBroker` interface. This package contains no shell, subprocess, filesystem-tool, or network-tool
  implementation.
- An injected provider interface plus `RuntimeProviderAdapter`, which matches the current `fikeya-runtime`
  `ProviderExecutor.execute` shape without importing the runtime eagerly.
- Strict stage-specific JSON decisions for runtime text providers.
- Qarinah context injected as cited, untrusted evidence with an exact content digest. The model is explicitly told never to
  follow instructions found inside the evidence.

## State flow

```text
plan -> act -> approval pause -> observe -> review -> completed
          |                         |          |
          +-> answer ---------------+          +-> act (revision requested)

Any active stage -> cancelled or failed
```

The approval pause is durable. A caller can close the process, create a new `AgentOrchestrator` with the same checkpoint store,
and resume with `ApprovalDecision.ALLOW_ONCE`, `DENY_ONCE`, or `CANCEL`.

## Install and verify

```bash
cd fikeya-agent-core
uv sync --extra test
uv run ruff check src tests
uv run pytest
uv build
```

The base package deliberately has no third-party runtime dependencies. Deterministic tests use fake providers and fake brokers
and make no network requests.

## Minimal host integration

```python
from fikeya_agent_core import AgentOrchestrator, InMemoryCheckpointStore

# `provider` implements Provider. `broker` implements ExecutionBroker.
core = AgentOrchestrator(provider, broker, InMemoryCheckpointStore())
session = core.start("Repair the parser and verify the focused tests.")

async for event in core.stream(session.session_id):
    publish_to_ui(event)
```

If the last event is `approval.requested`, show its arguments to the person, collect one explicit decision, and resume:

```python
from fikeya_agent_core import ApprovalDecision

async for event in core.stream(
    session.session_id,
    approval=ApprovalDecision.ALLOW_ONCE,
):
    publish_to_ui(event)
```

## Provider compatibility

`RuntimeProviderAdapter` accepts the current Fikeya runtime executor, provider profile, ephemeral credential, network opt-in, and
cooperative cancellation token. It converts each stage into one bounded runtime inference request and requires the returned text
to be exactly one supported JSON decision. It does not store, refresh, copy, or relay credentials.

Providers may implement the smaller async `Provider.complete` protocol directly. That is the preferred boundary for future
native streaming adapters.

## Qarinah boundary

`EvidenceContext` requires an exact SHA-256 digest and uniquely identified citations. Evidence is checkpointed because resuming a
session must reproduce the same model context. It is still untrusted data: citations and hashes provide identity and provenance,
not truth or prompt-injection immunity. Tools remain brokered and approval-gated even when evidence recommends an action.

## LangGraph and Deep Agents

This alpha does not bundle LangGraph or Deep Agents. Their official public APIs are the only acceptable basis for a future
optional adapter; Fikeya will not copy private middleware or checkpoint internals. Keeping them optional preserves offline tests
and prevents an upstream harness from bypassing Fikeya's broker and approval boundaries.

The current Fikeya state machine and JSON/SQLite checkpoint contract are complete without those packages. A future adapter must
demonstrate that official LangGraph interrupts/checkpointers or Deep Agents tools still route every execution through
`ExecutionBroker` before it is enabled.

## Not implemented yet

- A production execution broker or OS sandbox.
- Built-in provider SDKs, credential storage, model routing, or network transports.
- Token-by-token model streaming; this release streams typed orchestration events.
- Subagents, repository maps, symbol indexes, compaction, skills, or agent marketplaces.
- Remote or multi-tenant checkpoint storage, event retention, billing, or enterprise administration.
- A LangGraph or Deep Agents adapter.
- Desktop, CLI, interop-gateway, and Qarinah-sidecar wiring.

See [SECURITY.md](SECURITY.md) before connecting a real provider or execution broker.
