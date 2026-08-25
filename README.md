# Fikeya

Fikeya is an open, provider-neutral AI code editor and coding-agent runtime with two interfaces: a desktop editor for visual work and a CLI for headless automation. It is designed to plan, edit, run, and review software work while compiling only the bounded project context a turn needs.

Its optimization goal is **verified work per dollar**: preserve task quality and external verification while reducing unnecessary context, recording exact provider usage when available, and avoiding lock-in to one model or agent. That is a product target measured by matched evaluations, not a claim that every Fikeya run is already cheaper than another system.

## What Fikeya Includes

- **Five working modes:** Editor, Agent, Terminal, Review, and Lab, each focused on a distinct development workflow in Fikeya Desktop. The VS Code extension stays a focused Agent workspace instead of duplicating the host editor.
- **Two desktop layouts:** Studio for code-first work and Agent Focus for plan-first work.
- **Provider-neutral configuration:** Azure OpenAI, OpenAI API models (including Codex-capable models available to the API account), Anthropic, OpenRouter, NVIDIA NIM, Google Gemini, Hugging Face Inference Providers, Groq, Ollama, Vertex AI through its compatible endpoint, and other OpenAI-compatible endpoints.
- **Quota-aware model handoff:** when a provider returns HTTP 429, the Desktop can ask to continue with another configured profile or remember an always-switch preference. The new run recompiles the same bounded Qarinah project context; credentials and failed response bodies are not carried across providers.
- **One runtime for Desktop and CLI:** shared provider, approval, tool, usage, context, and evidence contracts across both interfaces.
- **Qarinah context engine:** compact, evidence-linked project context assembled from decisions, tool outcomes, worktrees, symbols, and cited receipts.
- **Bounded provider execution:** workspace-root validation, explicit network consent, cancellation, and content-free request and response hashes.
- **Measurable efficiency:** provider-reported input, cached-input, and output usage stays distinct from local estimates, and matched benchmark receipts fail closed when conditions differ.
- **Open protocols:** ACP for complete agents and MCP for tools and resources.
- **Reviewed browser and crawler presets:** validated, digest-bound connector configuration that stays disabled until the developer explicitly enables it; the connector process and MCP session are separate integrations.
- **Integrated native-agent core:** typed plan, act, observe, and review stages with cancellation, bounded retries, exact-call approvals, workspace tools, changed-file hashes, test outcomes, and execution receipts in both Desktop and CLI.
- **Plan before execution:** Chat can ask one configured provider for a strict `fikeya.plan-proposal.v1` draft. That planning turn has no tool channel and cannot execute workspace operations. The persisted draft must be reviewed, each canonical tool call must receive its own exact single-use approval, and bounded execution must finish with verification evidence before Fikeya labels the plan successful.

## Product Shape

```text
Fikeya Desktop                         Fikeya CLI
Editor | Chat | Plan | Context | Usage       init | doctor | provider | agent | plan | tool
                    │
                    ▼
             Fikeya Local Gateway
ACP | MCP | typed events | approvals | cancellation | resume
                    │
                    ▼
              Fikeya Runtime
provider calls | draft plans | execution broker | verification receipts
                    │
          ┌─────────┼──────────┐
          ▼                    ▼
       Qarinah          ACP and MCP adapters
   context engine       plus reviewed presets
```

The plan-to-proof path is intentionally split: a provider may propose a typed draft, but it cannot approve or execute that draft. A developer reviews the persisted plan and issues exact approvals for the selected step calls; Fikeya then runs only those approved calls inside the initialized workspace and records execution and verification hashes. See the [product contract](docs/fikeya/PLAN_TO_PROOF.md) and [runtime commands](fikeya-runtime/README.md#propose-review-and-run-a-durable-plan).

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

## Release status

Fikeya 0.1.0-beta.2 is the current public-beta source candidate. This milestone adds provider-generated draft plans through a planning-only turn with no tool channel, a separate durable Plan surface, explicit developer review, exact one-use approvals for canonical calls, bounded execution, and terminal verification receipts. It also retains the branded Code OSS desktop, focused VS Code extension, secure Python runtime and CLI, provider profiles, local usage statistics, Qarinah initialization and graph inspection, ACP and MCP interoperability packages, and opt-in browser and crawler presets. Stable release gates remain: signed Windows, macOS, and Linux artifacts, clean-install verification on all three platforms, and a verified Desktop update feed.

The VS Code extension follows the host's extension update channel. Fikeya Desktop does not silently download or force an unsigned executable. A future mandatory-update policy must verify a signed release manifest before it can block an unsupported build.

Until beta-2 artifacts pass the release gates and are published, the latest downloadable Windows Desktop installer, focused VSIX, and CLI wheel bundle remain in the [0.1.0-beta.1 release](https://github.com/AjnasNB/fikeya/releases/tag/v0.1.0-beta.1). That published release includes SHA-256 checksums, a machine-readable verification manifest, and GitHub artifact provenance. Its Windows installer is not Authenticode-signed, so Windows can show an unknown-publisher warning. The beta-2 candidate must also be treated as unsigned unless its final `release-verification.json` reports a valid trusted signature. See the [release process](docs/fikeya/RELEASE.md) for the exact signing and promotion gates.

If Fikeya is useful to you, [sponsor its continued development](https://github.com/sponsors/AjnasNB).

## Contributors

Fikeya is maintained by **Ajnas N B (`AjnasNB`)**, with pull-request review from the `cognifyrdotco` repository collaborator. The desktop foundation remains credited to the Code OSS community through Git history and the retained third-party notices. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the explicit attribution boundary.

## Development

Fikeya's public-beta bootstrap validates the checkout, creates a per-checkout Python environment in the current user's cache, installs the matched Agent Core and Runtime with Azure identity support, and verifies the locked protocol and Qarinah sidecar components. It never requests provider credentials.

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

See [LICENSE.txt](LICENSE.txt), the [distribution license map](LICENSES/README.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Upstream

Fikeya Desktop is built on [Code OSS](https://github.com/microsoft/vscode). Microsoft Visual Studio Code product branding, proprietary services, and Marketplace access are not part of Fikeya.
