# Fikeya

Fikeya is an open, provider-neutral AI code editor and coding-agent runtime with two interfaces: a desktop editor for visual work and a CLI for headless automation. It is designed to plan, edit, run, and review software work while compiling only the bounded project context a turn needs.

Its optimization goal is **verified work per dollar**: preserve task quality and external verification while reducing unnecessary context, recording exact provider usage when available, and avoiding lock-in to one model or agent. That is a product target measured by matched evaluations, not a claim that every Fikeya run is already cheaper than another system.

## What Fikeya Includes

- **Four working modes:** Editor, Agent, Terminal, and Review, each focused on a distinct development workflow.
- **Two desktop layouts:** Studio for code-first work and Agent Focus for plan-first work.
- **Provider-neutral configuration:** Azure OpenAI, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Ollama, and OpenAI-compatible endpoints.
- **One runtime for Desktop and CLI:** shared provider, approval, tool, usage, context, and evidence contracts across both interfaces.
- **Qarinah context engine:** compact, evidence-linked project context assembled from decisions, tool outcomes, worktrees, symbols, and cited receipts.
- **Bounded provider execution:** workspace-root validation, explicit network consent, cancellation, and content-free request and response hashes.
- **Measurable efficiency:** provider-reported input, cached-input, and output usage stays distinct from local estimates, and matched benchmark receipts fail closed when conditions differ.
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
provider calls | context budgets | connector presets | usage receipts
                    │
          ┌─────────┼──────────┐
          ▼                    ▼
       Qarinah          ACP and MCP adapters
   context engine       plus reviewed presets
```

## Efficiency Evidence

Fikeya evaluates efficiency as cost per externally verified successful task, not as raw token reduction in isolation. Comparisons must use the same repository state, task, model and API version, pricing snapshot, tool contract, network policy, limits, and grader. Failed attempts remain in total cost.

The dependency-free comparator in [`bench/fikeya-efficiency`](bench/fikeya-efficiency/README.md) validates those conditions and computes solve rate, billed tokens, total cost, cost per verified task, and latency percentiles from completed receipts. Its checked-in fixtures are synthetic contract tests, not product-performance evidence and not a marketing claim.

```powershell
npm --prefix bench/fikeya-efficiency test
npm --prefix bench/fikeya-efficiency run compare:fixtures
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
