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

Open a trusted local folder, then use **Fikeya: Initialize Workspace** and **Fikeya: Run Doctor**. The extension invokes the `fikeya` CLI with an argument array, a bounded output size, a timeout, no shell, and the local workspace as its working directory.

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
