# Fikeya

Fikeya is an open coding-agent workbench with one runtime and two interfaces: a desktop editor for visual work and a CLI for headless automation. It is designed to plan, edit, run, review, and resume software work without locking the project to one model provider.

Its goal is simple: let developers use the model and agent they prefer without losing project memory, control of tools, or a verifiable record of what changed.

## What Fikeya Includes

- **Four working modes:** Editor, Agent, Terminal, and Review.
- **Two desktop layouts:** Studio for code-first work and Agent Focus for plan-first work.
- **Provider-neutral configuration:** Azure OpenAI, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Ollama, and OpenAI-compatible endpoints.
- **One runtime for Desktop and CLI:** the same session, approval, tool, usage, and evidence contracts in both interfaces.
- **Qarinah project memory:** compact, evidence-linked project context, decisions, tool outcomes, worktrees, and context receipts.
- **Bounded provider execution:** workspace-root validation, explicit network consent, cancellation, and content-free request and response hashes.
- **Open protocols:** ACP for complete agents and MCP for tools and resources.
- **Reviewed browser and crawler presets:** validated, digest-bound connector configuration that stays disabled until the developer explicitly enables it; the connector process and MCP session are separate integrations.
- **Standalone native-agent core:** typed plan, act, observe, and review stages with checkpoints, cancellation, bounded retries, exact-call approvals, and execution receipts. Wiring this package into the Desktop turn is a remaining alpha integration task.

## Product Shape

```text
Fikeya Desktop                         Fikeya CLI
Editor | Agent | Terminal | Review     init | doctor | provider | agent | tool
                    │
                    ▼
             Fikeya Local Gateway
ACP | MCP | typed events | approvals | cancellation | resume
                    │
                    ▼
              Fikeya Runtime
provider calls | connector presets | usage receipts
                    │
          ┌─────────┼──────────┐
          ▼                    ▼
       Qarinah          ACP and MCP adapters
        memory          plus reviewed presets
```

## Security Model

Provider credentials are stored in VS Code SecretStorage or the operating-system credential store. Configuration files contain secret references, never plaintext keys. The runtime communicates over local stdio, does not expose an unauthenticated HTTP service, and does not execute model-supplied shell strings directly.

See [the security model](docs/fikeya/SECURITY.md) and [architecture](docs/fikeya/ARCHITECTURE.md).

## Build Status

Fikeya is under active public-alpha development. The current milestone covers the branded Code OSS desktop, secure Python runtime, provider profiles, CLI, ACP and MCP interoperability packages, workspace initialization, opt-in browser and crawler tool presets, a checkpointed native agent core, and Qarinah integration. It is not described as a stable release until clean-install Desktop and CLI fixtures pass on Windows, macOS, and Linux and the packaged artifacts are signed.

## Development

Fikeya's developer-alpha bootstrap validates the checkout, creates a per-checkout Python environment in the current user's cache, installs the runtime with Azure identity support, and verifies the locked protocol and Qarinah sidecar components. It never requests provider credentials.

```powershell
pwsh -NoProfile -File scripts/fikeya/bootstrap.ps1 -CheckOnly
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

The Code OSS base and its bundled upstream components retain their original MIT and third-party licenses. Fikeya-owned runtime, product-layer, and Python interoperability code are licensed under AGPL-3.0-or-later unless a file states otherwise. The `@fikeya/protocol` TypeScript package and its public schemas are Apache-2.0 so other tools can implement the wire contract.

Open source permits inspection, modification, redistribution, and commercial use under the applicable licenses. Fikeya preserves required notices and does not claim that copyleft prevents copying.

See [LICENSE.txt](LICENSE.txt), `LICENSES/`, and `THIRD_PARTY_NOTICES.md`.

## Upstream

Fikeya Desktop is built on [Code OSS](https://github.com/microsoft/vscode). Microsoft Visual Studio Code product branding, proprietary services, and Marketplace access are not part of Fikeya.
