# Fikeya Desktop

Fikeya Desktop is the built-in workbench surface for the local Fikeya runtime. It keeps the editor, agent controls, terminal, review surface, provider setup, workspace diagnostics, and Qarinah status in one product shell.

## Modes and layouts

- **Editor** focuses the active editor group.
- **Agent** returns to the Fikeya agent controls.
- **Terminal** focuses the integrated terminal.
- **Review** opens source control for change review.
- **Studio** shows workspace setup, providers, memory status, approvals, and receipts.
- **Agent Focus** reduces the panel to the active mode and its primary controls.

The selected mode and layout are persisted in VS Code global state. A webview message cannot invoke arbitrary workbench commands: the extension validates every mode, layout, and command against a fixed allowlist.

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

## Live alpha surfaces

The Agent surface reads configured profiles from `fikeya provider list --json` and runs one provider turn through `fikeya agent run`. A prompt is sent only over stdin. Each run requires a fresh network-consent checkbox, can be cancelled, and keeps output only in the current webview session. Exact token counts are shown only when the provider reports them. Content-free call and session receipts can be refreshed from local runtime state. Provider response bodies and stderr are not surfaced as error details.

The Studio layout also reads a compact, bounded graph from the pinned Qarinah package through a local JSON-RPC adapter. Search, type filters, node dragging, canvas pan and zoom are local. Node evidence hashes, graph manifest, and ledger head are displayed when present. If Qarinah is missing, uninitialized, invalid, too large, or times out, the graph says it is unavailable; it never substitutes sample data.

The current alpha still uses VS Code's existing editor, terminal, and source-control views for Editor, Terminal, and Review modes. The approvals queue is an explicit empty-state preview because the extension does not yet subscribe to live approval events. Provider output is delivered after a completed turn; the UI does not simulate token streaming.

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
