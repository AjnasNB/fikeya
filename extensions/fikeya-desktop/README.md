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
2. stores it through VS Code Secret Storage;
3. streams it once to `fikeya provider configure` over stdin;
4. lets Fikeya Runtime retain its own opaque OS-keyring reference.

Azure OpenAI defaults to Entra ID and sends no credential payload. Ollama is credential-free and permits plain HTTP only on a loopback address. Other provider endpoints must use HTTPS.

This extension configures and verifies the local control surface. The model execution loop, tool adapters, usage receipts, and approval outcomes are supplied by Fikeya Runtime as those capabilities become available; the UI deliberately does not fabricate their status.
