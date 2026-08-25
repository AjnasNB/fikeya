# Agent-core security boundary

## Authority model

The model proposes plans, answers, and tool calls. It has no authority to execute a command, open a file, use the network, or
approve its own request. The host owns the provider and `ExecutionBroker` implementations. Every proposed tool call pauses in a
durable `awaiting_approval` state before `ExecutionBroker.execute` can be called.

The broker remains responsible for workspace boundaries, command allowlists, sandboxing, network policy, resource enforcement,
and result provenance. An implementation that invokes a shell directly without those controls is outside this package's trust
model.

## Enforced here

- Stage-specific provider decisions are typed and fail closed.
- Every provider stage requires an exact JSON key set. Unknown fields, unavailable tools, duplicate tool names, mismatched call
  identifiers, and malformed results are rejected.
- Model context, provider output, tool arguments, tool results, tool metadata, steps, retries, and operation duration are bounded.
- Every checkpoint is deterministic JSON. There is no pickle or executable deserialization fallback.
- SQLite saves use optimistic revisions so two stale orchestrators cannot silently overwrite each other.
- Approval responses are bound to the request, session, call, tool, argument digest, and checkpoint revision. A response for an
  older or altered call cannot create a grant.
- Event receipts retain hashes, byte counts, identifiers, and decisions, but not tool arguments, tool output, or final answer
  text. The checkpoint still retains bounded content required to resume the session.
- An approved call receives a durable one-use grant, stable idempotency key, and execution lease before broker dispatch.
- Active cancellation signals the provider or broker cooperatively; idle cancellation is immediately checkpointed.

## Sensitive retained content

Unlike the content-free interop receipts, resumable agent checkpoints contain the task prompt, Qarinah evidence, plans,
observations, review notes, and final answer. Treat the SQLite file as sensitive project data. The deployment layer must set OS
permissions, retention, backup, encryption, and deletion policy. Do not place credentials in prompts, evidence, tool arguments,
or tool results.

## Qarinah evidence

Qarinah content is labelled as untrusted cited evidence. A digest proves byte identity, not correctness. Prompt injection remains
possible at the model layer, so evidence can never grant authority. The broker and approval boundary must remain authoritative.

## Cancellation and timeouts

Cancellation is cooperative. The core cannot forcibly stop a provider thread, network socket, container, or broker process.
`asyncio` timeouts bound how long the orchestrator waits, but a non-cooperative implementation may continue outside the core.
Production adapters must implement their own transport cancellation and the execution broker must enforce hard process limits.

## Broker idempotency and uncertain outcomes

`ExecutionBroker.execute` is called at most once by a single orchestration attempt and is never automatically retried. The
broker contract requires exact-once behavior per supplied idempotency key, including returning a cached result when the same key
is reconciled after a crash. A timeout, cancellation, or exception after dispatch is recorded as
`broker_outcome_uncertain`; the exact grant and lease remain durable. The host must reconcile that key with the broker and call
`reconcile_tool_result` with the matching result. It must not replay the side effect under a new key.

The in-memory per-instance stream guard is only a convenience. Cross-process safety comes from optimistic checkpoint revisions,
the durable execution lease, and broker-side key deduplication. Production checkpoint implementations need the same atomic
compare-and-swap semantics as the included SQLite store.

## Reporting

Do not place credentials, private prompts, customer source, or checkpoint databases in a public issue. Follow the repository's
private security-reporting process and provide the smallest content-free reproduction possible.
