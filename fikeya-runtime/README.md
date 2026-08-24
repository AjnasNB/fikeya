# Fikeya Runtime

Fikeya Runtime is the local-first execution and protocol foundation for Fikeya.
It provides a typed session event stream, resumable and forkable sessions,
provider configuration backed by the operating system credential store,
bounded OpenAI-compatible model execution, exact provider-usage receipts,
content-free context receipts, and an approval-gated tool broker.

This is an alpha foundation. It deliberately does not run a shell string,
silently send project content to a model, or persist API keys in JSON or SQLite.

## Install for development

```console
python -m venv .venv
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
Azure OpenAI, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Ollama, and generic
OpenAI-compatible endpoints.

Provider connectivity is never tested during configuration or ordinary test
runs. A network request occurs only when a person explicitly runs:

```console
fikeya provider test work --allow-network
```

The command reports status and latency without printing a response body or
credential.

## Run one bounded agent turn

Fikeya's first execution slice supports the Responses API and OpenAI-compatible
chat completions. The prompt enters through standard input so it is not exposed
in the process list. Network use always requires an explicit opt-in.

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
provider-reported input, output, and cache tokens. If a provider omits usage,
the receipt says `unavailable`; Fikeya does not invent an estimate.

```console
fikeya agent receipts ses_example --workspace . --json
```

Current execution support is deliberately scoped:

- Azure OpenAI and OpenAI default to the Responses API.
- OpenRouter, NVIDIA NIM, Ollama, and generic OpenAI-compatible profiles default
  to chat completions. Compatible profiles may opt into Responses explicitly.
- Anthropic profiles can be stored and probed, but native Anthropic execution is
  not claimed by this runtime slice.
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

## Qarinah boundary

`QarinahAdapter` invokes a separately installed `qarinah` executable with an
argument vector and `shell=False`. Fikeya may return the live CLI response to its
caller, but durable Fikeya state stores only content-free metadata such as byte
length, exit status, duration, and a SHA-256 digest. It does not persist the
query or returned context body.

## License

Fikeya-owned runtime code is available under
`AGPL-3.0-or-later`. The surrounding Code OSS repository and separately
installed tools retain their own licenses. See `THIRD_PARTY_NOTICES.md`.
