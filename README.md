# Fikeya

Fikeya is an open coding-agent workbench with one runtime and two interfaces: a desktop editor for visual work and a CLI for headless automation.

Its goal is simple: let developers use the model and agent they prefer without losing project memory, control of tools, or a verifiable record of what changed.

## What Fikeya Includes

- **Four working modes:** Editor, Agent, Terminal, and Review.
- **Two desktop layouts:** Studio for code-first work and Agent Focus for plan-first work.
- **Provider-neutral configuration:** Azure OpenAI, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Ollama, and OpenAI-compatible endpoints.
- **One runtime for Desktop and CLI:** the same session, approval, tool, usage, and evidence contracts in both interfaces.
- **Qarinah project memory:** compact, evidence-linked project context, decisions, tool outcomes, worktrees, and context receipts.
- **Bounded execution:** workspace-root validation, explicit approvals, cancellation, disposable Git worktrees, and post-execution hashes.
- **Open protocols:** ACP for complete agents and MCP for tools and resources.
- **Optional browser and crawler tools:** available only after the developer grants the relevant permission.

## Product Shape

```text
Fikeya Desktop                         Fikeya CLI
Editor | Agent | Terminal | Review     init | run | review | doctor
                    │
                    ▼
             Fikeya Local Gateway
ACP | MCP | typed events | approvals | cancellation | resume
                    │
                    ▼
              Fikeya Runtime
providers | planning | tools | worktrees | usage receipts
                    │
          ┌─────────┼──────────┐
          ▼         ▼          ▼
       Qarinah    Browser    Crawler
        memory      tools      tools
```

## Security Model

Provider credentials are stored in VS Code SecretStorage or the operating-system credential store. Configuration files contain secret references, never plaintext keys. The runtime communicates over local stdio, does not expose an unauthenticated HTTP service, and does not execute model-supplied shell strings directly.

See [the security model](docs/fikeya/SECURITY.md) and [architecture](docs/fikeya/ARCHITECTURE.md).

## Build Status

Fikeya is under active foundation development. The current milestone covers the branded Code OSS desktop, secure Python runtime, provider profiles, CLI, local gateway contract, workspace initialization, approval-aware tools, and the first Qarinah integration. Release claims will be added only after clean-install Desktop and CLI fixtures pass on Windows, macOS, and Linux.

## Development

Fikeya's developer-alpha bootstrap validates the checkout, creates a per-checkout Python environment in the current user's cache, installs the runtime with Azure identity support, and verifies the locked protocol and Qarinah sidecar components. It never requests provider credentials.

```powershell
pwsh -NoProfile -File scripts/fikeya/bootstrap.ps1 --check-only
pwsh -NoProfile -File scripts/fikeya/bootstrap.ps1
```

On macOS or Linux, run the equivalent checked-in script with `sh scripts/fikeya/bootstrap.sh`. See the [bootstrap contract](docs/fikeya/BOOTSTRAP.md) for prerequisites, cache behavior, security boundaries, and current reproducibility limits.

The editor shell follows the upstream Code OSS build process. Fikeya-specific work lives in the built-in desktop extension, protocol package, Python runtime, integrations, tests, and public site. Building the full desktop remains a separate step:

```powershell
npm install
npm run compile
```

The Python runtime also has focused setup and test commands in [`fikeya-runtime/README.md`](fikeya-runtime/README.md).

## Licensing

The Code OSS base and its bundled upstream components retain their original MIT and third-party licenses. Fikeya-owned runtime and product-layer code are licensed under AGPL-3.0-or-later unless a file states otherwise. Public protocol schemas and interoperability SDKs are intended to remain permissively licensed so other tools can implement them.

Open source permits inspection, modification, redistribution, and commercial use under the applicable licenses. Fikeya preserves required notices and does not claim that copyleft prevents copying.

See [LICENSE.txt](LICENSE.txt), `LICENSES/`, and `THIRD_PARTY_NOTICES.md`.

## Upstream

Fikeya Desktop is built on [Code OSS](https://github.com/microsoft/vscode). Microsoft Visual Studio Code product branding, proprietary services, and Marketplace access are not part of Fikeya.
