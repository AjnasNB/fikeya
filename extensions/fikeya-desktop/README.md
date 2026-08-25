# Fikeya Desktop

Fikeya Desktop is the focused coding-agent workspace for the local Fikeya runtime. It keeps reviewed agent controls, provider setup, workspace diagnostics, the Qarinah graph, and exact receipts together without duplicating the editor, terminal, or source-control navigation already provided by the full desktop product.

## One agent workspace

Use **Fikeya: Open Fikeya** for the full-width editor-area panel, or open the Fikeya activity-bar view for the compact sidebar. Both surfaces share the same live state and expose the agent run, configured provider profiles, workspace setup, Qarinah memory graph, and durable receipts. Reopening the command reveals the existing panel rather than creating duplicate sessions or message listeners. A webview message cannot invoke arbitrary workbench commands: every command and action is validated against a fixed allowlist.

## Runtime setup

Open a trusted local folder, then use **Fikeya: Initialize Workspace** and **Fikeya: Run Doctor**. A packaged VSIX invokes its own platform-specific Fikeya Runtime executable with an argument array, a bounded output size, a timeout, no shell, and the local workspace as its working directory. It does not require a global `fikeya` command or Python installation. A source checkout without a bundled runtime retains a PATH fallback for development only.

The extension understands the actual JSON emitted by:

```text
fikeya init --json
fikeya doctor --json
```

Doctor results reconcile workspace initialization, configured provider count, and the optional Qarinah CLI status. No token or cost metric is shown until a real provider response supplies a receipt.

## Provider credentials

Provider metadata contains the profile name, provider kind, model, endpoint, and credential type. Credential bytes never enter command arguments, ordinary extension state, webview HTML, logs, or error messages.

For providers that require a secret, Fikeya Desktop:

1. collects the credential in a password input;
2. streams it once to `fikeya provider configure` over stdin;
3. lets Fikeya Runtime retain its opaque OS-keyring reference.

Azure OpenAI defaults to Entra ID and sends no credential payload. Ollama is credential-free and permits plain HTTP only on a loopback address. Other provider endpoints must use HTTPS.

## Live beta-candidate surfaces

The Agent surface reads configured profiles from `fikeya provider list --json` and runs the reviewed plan-act-observe-review loop through `fikeya agent execute`. Prompts and approval decisions travel over a private JSON Lines stdin protocol and never enter process arguments. Every workspace read, edit, or process request pauses for an exact **Allow Once**, **Deny Once**, or **Cancel Run** decision. Completed runs show the plan, result, changed files, tool and test outcomes, provider-reported usage, and Qarinah evidence. Content-free call and session receipts can be refreshed from local runtime state; provider response bodies and stderr are not persisted as error details.

The workspace also reads a compact, bounded graph from the pinned Qarinah package through a local JSON-RPC adapter. Search, type filters, node dragging, canvas pan and zoom are local. Node evidence hashes, graph manifest, and ledger head are displayed when present. If Qarinah is missing, uninitialized, invalid, too large, or times out, the graph says it is unavailable; it never substitutes sample data.

The **Local Usage & Statistics** view calls `fikeya stats --workspace <path> --json` and displays content-free aggregates from that workspace's runtime SQLite database: sessions, provider calls, provider-reported input/cached/output tokens, Qarinah context receipts, activity time, and provider/model breakdowns. Missing provider token measurements remain unavailable instead of being estimated. Refresh is manual as well as post-run, nothing is sent to Fikeya analytics, and the view does not claim Marketplace or native auto-update support.

The full Fikeya Desktop and Code OSS shell retain their editor, terminal, source-control, and review surfaces. This extension intentionally presents one coding-agent workspace instead of another mode switcher. Provider output is delivered after a completed run; the UI does not simulate token streaming. The provider picker includes Azure OpenAI, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Google Gemini, Ollama, and a Vertex AI or other OpenAI-compatible endpoint. Consumer AI subscriptions are not reused as API credentials.

The extension follows the update mechanism of its VS Code-compatible host. The standalone desktop still needs signed native packages and a signature-verified update manifest before it can enforce a minimum supported version; it does not force-install an unsigned build.

## Standalone VSIX

From this directory, build and inspect the extension with:

```text
npm ci
python -m pip install -r runtime-build-requirements.txt
npm run package:vsix
```

The reproducible, platform-targeted build writes `artifacts/fikeya-desktop-0.1.0-<target>.vsix`. It compiles and runs the focused test suite, freezes the local Fikeya Runtime into an extension-owned executable, bundles only the reachable Qarinah 0.4.0 workspace and dashboard runtime, invokes the official pinned `@vscode/vsce` packager, and then reopens the archive to verify its allowlisted contents and hashes. A fixed `SOURCE_DATE_EPOCH` is used by default so identical inputs produce the same VSIX bytes; release automation may supply another valid epoch explicitly.

The package includes the extension's full AGPL-3.0-or-later license, Qarinah's Apache-2.0 license and notice, the MIT notice for the bundled ignore parser, and the embedded Python runtime's dependency licenses. It excludes TypeScript sources, tests, source maps, `node_modules`, development caches, local `.qarinah`/`.codex` state, SQLite files, event ledgers, and credential-shaped material. Both bundled runtimes carry content hashes and dependency receipts.

`npm run test:isolated-vsix` extracts the built archive into a fresh profile, empties `PATH`, initializes Fikeya and Qarinah, runs doctor, and loads the real zero-event Qarinah graph. No global Fikeya installation or synthetic graph fixture participates in that check.

This artifact is the Fikeya Desktop VS Code extension. It is not a branded Fikeya desktop executable. Local and CI VSIX files are unsigned until the publisher completes marketplace identity, signing, and release-channel setup.
