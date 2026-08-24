# Fikeya Runtime

Fikeya Runtime is the local-first execution and protocol foundation for Fikeya.
It provides a typed session event stream, resumable and forkable sessions,
provider configuration backed by the operating system credential store,
content-free usage and context receipts, and an approval-gated tool broker.

This is an alpha foundation. It deliberately does not run a shell string,
silently send project content to a model, or persist API keys in JSON or SQLite.

## Install for development

```console
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[test]"
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

Provider secrets are accepted through a hidden prompt by default. For CI or a
local script, pipe the value through standard input. Never place a secret in a
command argument.

```console
fikeya provider configure work \
  --kind azure-openai \
  --base-url https://example.openai.azure.com \
  --model my-deployment
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
