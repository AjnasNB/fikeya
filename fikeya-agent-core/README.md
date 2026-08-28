# Fikeya Agent Core

Fikeya Agent Core is the first native, provider-neutral coding-agent orchestration slice for Fikeya. It advances a durable
session through `plan -> act -> observe -> review`, pauses every proposed tool call for an explicit approval, and delegates all
execution to an injected broker.

This is a beta orchestration component. It is not by itself a complete IDE agent and does not claim feature parity with Claude Code,
Codex, Cursor, Deep Agents, or any other agent product.

## Implemented

- A typed plan, act, observe, and review state machine with terminal completed, cancelled, and failed states.
- Resumable, optimistic JSON checkpoints using an in-memory store or durable SQLite. Pickle is never used.
- Typed async streaming events with a bounded, durable outbox and monotonic per-session sequences. Consumers resume with an
  `after_sequence` cursor; an interrupted pending approval is re-emitted.
- Explicit approval requests bound to the request ID, session, call ID, tool name, exact argument digest, and checkpoint
  revision. A one-use grant is checkpointed before execution.
- A per-session execution lease and stable broker idempotency key. The broker must deduplicate that key and return its cached
  result for duplicates.
- Cooperative cancellation, provider and broker timeouts, bounded provider retries, step limits, context limits, and output
  limits. Broker calls are never automatically retried because their side effects may already have occurred.
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

The approval pause and its exact call binding are durable. A caller can close the process, create a new `AgentOrchestrator`
with the same checkpoint store, reconstruct an `ApprovalResponse` from the latest `pending_approval`, and resume safely.

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

If the last event is `approval.requested`, read the bounded arguments from `core.state(session_id).pending_call`, show them to
the person, and construct a response from the current request. The event receipt contains sizes and hashes, not arguments:

```python
from fikeya_agent_core import ApprovalDecision, ApprovalResponse

request = core.state(session.session_id).pending_approval
assert request is not None
response = ApprovalResponse(
    request.request_id,
    request.session_id,
    request.call_id,
    request.tool_name,
    request.arguments_sha256,
    request.expected_revision,
    ApprovalDecision.ALLOW_ONCE,
)

async for event in core.stream(
    session.session_id,
    approval=response,
):
    publish_to_ui(event)
```

If a broker call disconnects or times out after dispatch, the session fails with `broker_outcome_uncertain` while retaining its
grant and lease. Query the broker by the retained idempotency key, then pass the verified result to
`reconcile_tool_result`. Never create a new tool call to guess the outcome.

## Provider compatibility

`RuntimeProviderAdapter` accepts the current Fikeya runtime executor, provider profile, a credential supplier, network opt-in,
and cooperative cancellation token. It asks the supplier immediately before each call and does not retain the returned secret
as adapter state. Each stage accepts exactly its documented JSON keys. A host-provided error classifier can map known transient
runtime failures to bounded provider retries; unclassified failures pass through and fail closed.

Providers may implement the smaller async `Provider.complete` protocol directly. That is the preferred boundary for future
native streaming adapters.

## Qarinah boundary

`EvidenceContext` requires an exact SHA-256 digest and uniquely identified citations. Evidence is checkpointed because resuming a
session must reproduce the same model context. It is still untrusted data: citations and hashes provide identity and provenance,
not truth or prompt-injection immunity. Tools remain brokered and approval-gated even when evidence recommends an action.

## LangGraph and Deep Agents

This beta does not bundle LangGraph or Deep Agents. Their official public APIs are the only acceptable basis for a future
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
- The package does not bundle Desktop, CLI, interop-gateway, or Qarinah-sidecar code. Fikeya Runtime and the Desktop extension integrate the core through its public provider, broker, checkpoint, approval, cancellation, and event interfaces.

See [SECURITY.md](SECURITY.md) before connecting a real provider or execution broker.
