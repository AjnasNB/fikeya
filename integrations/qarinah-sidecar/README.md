# Fikeya Qarinah sidecar

This package is Fikeya's root-bound context-engine port. It runs over standard input and output, pins the stable Qarinah JavaScript API, and never opens a network listener.

It owns no model credentials and executes no shell commands. The desktop and runtime send typed lifecycle events; the sidecar maps them into Qarinah's append-only project ledger and returns budgeted cited context packs, receipts, worktree information, symbol results, and developer context-graph views.

## Protocol

Start one sidecar per authorized workspace:

```sh
node src/sidecar.mjs --root /absolute/path/to/project
```

Each input line is a JSON-RPC 2.0 request. Output is one JSON-RPC response per line. Requests are limited to one megabyte and can be cancelled with `$/cancelRequest`.

Supported methods:

- `runtime.version` returns the exact sidecar package, protocol, and pinned Qarinah version
- `memory.initialize`, `memory.policy`, `memory.approve`, and `memory.status`
- `memory.record`, `memory.prepare`, `memory.compact`, and `memory.refresh`
- `memory.inspect`, `memory.receipts`, and `memory.worktrees`
- `memory.scan`, `memory.symbols`, and `memory.symbolGraph.summary`

Content capture remains opt-in and policy-hash approved. `memory.prepare` rebuilds stale projections by default so a fresh event is immediately retrievable. A managed endpoint sends `rebuild: false`; that path also forces checkpoint updates off and therefore fails closed instead of changing Qarinah state.

Repository scanning and symbol indexing use hard file, byte, depth, result, and query limits. The graph-summary method returns coverage and hashes instead of sending the complete repository graph across the protocol. Symbol queries return bounded paths, spans, signatures, and reference structure; they do not return source-file bodies.

## Verify

```sh
npm ci
npm test
```

The integration test creates an isolated temporary workspace, approves its capture policy, writes a real decision to Qarinah, compiles a cited context pack, and removes the workspace afterward.

The Fikeya release packager publishes this sidecar as a deterministic archive.
Repository-owned UTF-8 text is normalized to LF; npm-generated `.bin` shims and
the nested installation snapshot are excluded; member paths must be portable
ASCII; archive entries use fixed timestamps, ordering, compression, and
regular `0644` metadata. The binding receipt attests canonical paths, sizes,
and file hashes with artifact modes normalized to zero, while link, reparse,
hardlink, special-file, containment, resource-limit, and mutation checks
remain mandatory.
