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
- Unknown JSON response fields, unavailable tools, duplicate tool names, mismatched call identifiers, and malformed results are
  rejected.
- Model context, provider output, tool arguments, tool results, tool metadata, steps, retries, and operation duration are bounded.
- Every checkpoint is deterministic JSON. There is no pickle or executable deserialization fallback.
- SQLite saves use optimistic revisions so two stale orchestrators cannot silently overwrite each other.
- Approval events disclose the bounded argument object and its digest to the host approval surface.
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

## Reporting

Do not place credentials, private prompts, customer source, or checkpoint databases in a public issue. Follow the repository's
private security-reporting process and provide the smallest content-free reproduction possible.
