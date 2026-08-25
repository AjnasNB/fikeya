# Interoperability security boundary

## Trust model

ACP agents, Codex app-server processes, MCP servers, their schemas, and their outputs are external peers. Fikeya does not trust a
peer because it is local or because it advertises a capability or MCP annotation.

## Enforced in this package

- Processes start with `create_subprocess_exec` or the official SDK equivalent. Shell parsing is never used.
- The host chooses an exact executable allowlist. The child working directory and host file callbacks are constrained to one
  resolved workspace root.
- Only a small environment allowlist is inherited. Variable names that look like keys, secrets, tokens, credentials, passwords,
  cookies, OAuth values, or authorization headers are rejected even if a caller attempts to allowlist them.
- Protocol messages, schemas, arguments, tool counts, tool names, output blocks, embedded resources, and request durations are
  bounded.
- MCP tools require a qualified `server/tool` allowlist. Tools not explicitly marked read-only require a separate host approval.
- Codex permission grants must be a structural subset of the permissions requested by app-server.
- Operation receipts contain hashes, byte counts, status, duration, and peer/operation names. They do not persist prompts, tool
  arguments, tool output, file contents, reasoning, or credentials.

## Not enforced here

- A root-bound working directory is not an operating-system sandbox. A child process inherits the user's OS identity and may open
  files, network sockets, credential stores, or devices that the OS permits.
- Executable signatures, package provenance, and supply-chain trust are deployment responsibilities.
- There is an unavoidable time-of-check/time-of-use window around ordinary path resolution. Run hostile children in the execution
  broker and mount only the intended worktree.
- MCP `readOnlyHint` and `destructiveHint` values are advisory. Fikeya's allowlist and approval remain authoritative.
- This package does not transport or refresh model-provider credentials. Provider secrets belong in the runtime's OS-backed secret
  store and must never be inserted into a manifest.

## Reporting

Do not open a public issue containing an exploit, credential, private prompt, or customer path. Follow the repository security
policy and provide the smallest content-free reproduction possible.
