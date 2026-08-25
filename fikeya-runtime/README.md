# Fikeya Runtime

Fikeya Runtime is the provider-neutral execution, bounded-context, and protocol foundation for the Fikeya AI code editor.
It provides a typed session event stream, resumable and forkable sessions,
provider configuration backed by the operating system credential store,
bounded OpenAI-compatible model execution, exact provider-usage receipts,
content-free context receipts, and an approval-gated tool broker.

This is the runtime included in the Fikeya beta candidate. It deliberately does not run a shell string,
silently send project content to a model, or persist API keys in JSON or SQLite.

## Install for development

```console
python -m venv .venv
.venv\Scripts\python -m pip install -e "../fikeya-agent-core"
.venv\Scripts\python -m pip install -e ".[azure,test]"
.venv\Scripts\python -m pytest
```

On macOS or Linux, activate the environment with
`source .venv/bin/activate` and use `python` directly.

## Initialize a workspace

```console
fikeya init .
fikeya doctor .
```

Initialization creates `.fikeya/workspace.json` and a local SQLite state file.
The state file and its journal files are ignored by the nested
`.fikeya/.gitignore`.

## Configure a provider safely

Provider secrets are accepted through a hidden prompt by default. For a local
script, pipe the value through standard input. Never place a secret in a
command argument, JSON file, workspace database, or source-controlled file.

Azure OpenAI uses Entra ID by default. Install the `azure` extra, sign in with
an Azure developer credential or supply a workload identity, and configure the
resource's v1 base URL. No Azure access token is persisted by Fikeya.

```console
fikeya provider configure work \
  --kind azure-openai \
  --base-url https://example.openai.azure.com/openai/v1 \
  --model my-deployment
```

An Azure API key remains an explicit alternative. It is written directly to
the OS keyring:

```console
printf '%s' "$AZURE_MODEL_KEY" | fikeya provider configure azure-key \
  --kind azure-openai \
  --credential-type api-key \
  --base-url https://example.openai.azure.com/openai/v1 \
  --model my-deployment \
  --secret-stdin
```

```console
printf '%s' "$MODEL_SECRET" | fikeya provider configure work \
  --kind openrouter \
  --model openai/gpt-oss-20b \
  --secret-stdin
```

The metadata file stores only a `keyring://...` reference. The secret itself is
written to the current user's operating system keyring. Supported profiles are
Azure OpenAI, OpenAI API models, Anthropic, OpenRouter, NVIDIA NIM, Google
Gemini, Ollama, and generic OpenAI-compatible endpoints. Codex-capable OpenAI
models work when they are available to the user's OpenAI API account. A
ChatGPT, Codex, Claude, or Gemini consumer subscription is not an API
credential. Vertex AI can use the compatible profile with its regional
OpenAI-compatible endpoint and a short-lived Google Cloud bearer token;
automatic Application Default Credentials refresh is not yet built into the
runtime.

List configured profiles without exposing credentials:

```console
fikeya provider list --json
```

Provider connectivity is never tested during configuration or ordinary test
runs. A network request occurs only when a person explicitly runs:

```console
fikeya provider test work --allow-network
```

The command reports status and latency without printing a response body or
credential.

## Run an agent turn with bounded project context

Prompts are accepted only through standard input. When Qarinah is installed and
the workspace has opted into retrieval, `auto` compiles a bounded cited project
pack and supplies it as explicitly untrusted reference context. This is context
selection for the active coding task, not a requirement to replay prior sessions. The prompt,
context body, and answer remain ephemeral; SQLite retains hashes, byte counts,
coverage, evidence counts, provider usage, and receipt identifiers.

```console
printf '%s' "Continue the current implementation" | fikeya agent run . \
  --provider work --prompt-stdin --allow-network --memory auto --json
```

Use `--memory required` to stop before contacting the model when cited project
context cannot be prepared. Use `--memory off` for a deliberately memory-free
turn.

## Run a reviewed coding loop

`fikeya agent execute` connects the provider-neutral runtime to Fikeya Agent
Core. The loop can list, read, and search project files; apply preconditioned
UTF-8 edits; invoke an allowlisted process without a shell; run tests; and
return a structured plan, changed-file hashes, tool receipts, test receipts,
usage, and Qarinah evidence.

This command is a bidirectional integration protocol for Fikeya Desktop and
other trusted local clients. Start it with:

```console
fikeya agent execute . --provider work --protocol-stdin --allow-network --json-lines
```

The client writes one JSON line containing `{"type":"start","prompt":"..."}`.
Before every workspace or process tool, the runtime emits a bounded `approval`
message containing the exact arguments and their SHA-256 digest. The client
must reply with the matching request ID and one decision: `allow_once`,
`deny_once`, or `cancel`. A successful loop ends with one `result` line. Prompt,
file content, tool output, plans, and final answers remain ephemeral; SQLite
keeps content-free events, hashes, provider receipts, and exact reported usage.

Process execution remains local. Command interpreters are prohibited, the
executable must be allowlisted, the working directory must remain inside the
initialized workspace, and an approved request cannot be reused or mutated.
Fikeya resolves the executable to an absolute PATH entry outside the workspace,
rejects Windows command-script shims, and owns the complete child process tree
so cancellation and timeout cleanup cannot leave a background tool running.

## Run one bounded agent turn

Fikeya's first execution slice supports the Responses API, Anthropic Messages,
and OpenAI-compatible chat completions. The prompt enters through standard input
so it is not exposed in the process list. Network use always requires an explicit
opt-in.

```console
printf '%s' "Explain the failing test." | fikeya agent run . \
  --provider work \
  --prompt-stdin \
  --allow-network
```

Use `--json` for a typed UI or automation result. Pressing Ctrl+C requests
cooperative cancellation, and active sessions can also be cancelled directly:

```console
fikeya agent cancel ses_example --workspace .
```

The live output is returned to the caller but is not written to SQLite. Fikeya
stores request and response hashes, byte counts, latency, status, and exact
provider-reported input, output, and cache tokens. Anthropic reports base input,
cache creation, and cache reads separately; Fikeya normalizes their sum into
`inputTokens` and preserves cache reads in `cachedInputTokens`. Cache creation is
therefore included in total input until the versioned receipt adds a separate
field. If a provider omits usage, the receipt says `unavailable`; Fikeya does not
invent an estimate.

```console
fikeya agent receipts ses_example --workspace . --json
```

Current execution support is deliberately scoped:

- Azure OpenAI and OpenAI default to the Responses API.
- OpenRouter, NVIDIA NIM, Ollama, and generic OpenAI-compatible profiles default
  to chat completions. Compatible profiles may opt into Responses explicitly.
- Anthropic profiles execute through the native Messages API.
- Cancellation is cooperative at request and response-stream boundaries. The
  configured timeout remains the hard bound while a socket operation is active.

## Tool safety model

`ToolBroker` accepts an argument vector, never a raw shell string. It starts in
dry-run mode. Real execution additionally requires all of the following:

1. The broker was created with execution enabled.
2. The executable is on the caller-supplied allowlist.
3. The working directory stays inside the initialized workspace.
4. A short-lived, single-use approval token matches the exact canonical request.

Changing an argument, directory, or environment key invalidates the approval.

### Reviewed external tool presets

Fikeya Runtime ships configuration-only presets for separately installed
Cockroach Browser and Cockroach Crawler CLIs. Both start disabled. Listing a
preset only checks whether its executable name is discoverable; it does not
run the executable, contact a network service, or claim that the installed
package or version is authentic.

```console
fikeya tool list --json
fikeya tool enable cockroach-browser --workspace . --confirm-workspace
fikeya tool status --workspace . --json
fikeya tool disable cockroach-browser --workspace .
```

Enablement is local to the initialized workspace and bound to the SHA-256
digest of the exact reviewed manifest. A changed manifest becomes disabled
until it is confirmed again. SQLite stores only the preset identifier, digest,
and enablement timestamp. Configuration values and credentials are never
stored in the enablement record, and enabling a preset does not start it.

The runtime loader resolves a fixed executable without a shell, constructs a
minimal child environment, and rejects filesystem-root workspaces, escaped
metadata paths, shell-script shims, unknown configuration fields, URL
credentials, private literal crawler IPs, and non-finite or widened limits.
Request bytes, response bytes, request count, concurrency, request timeout,
and total session duration are guarded by the loader. The caller remains
responsible for MCP message framing, cancellation, and terminating the child
on a protocol failure.

External executable provenance and version verification is intentionally an
explicit diagnostic warning in this alpha. On Windows, `.cmd`, `.bat`, and
PowerShell shims are rejected because the no-shell boundary requires a native
executable entry point.

## Qarinah context-engine boundary

`QarinahAdapter` invokes a separately installed `qarinah` executable with an
argument vector and `shell=False`. Fikeya may return the live CLI response to its
caller, but durable Fikeya state stores only content-free metadata such as byte
length, exit status, duration, and a SHA-256 digest. It does not persist the
query or returned context body.

## License

Fikeya-owned runtime code is available under
`AGPL-3.0-or-later`. The surrounding Code OSS repository and separately
installed tools retain their own licenses. See `THIRD_PARTY_NOTICES.md`.
