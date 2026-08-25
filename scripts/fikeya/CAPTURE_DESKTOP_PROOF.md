# Capture the real Fikeya Chat and Plan proof

`capture-desktop-proof.ts` launches the development Fikeya Electron build with a fresh isolated profile, the local Fikeya Desktop extension, a disposable project, an isolated `FIKEYA_HOME`, and an ephemeral deterministic OpenAI-compatible server bound to IPv4 loopback. It does not render a static HTML mock or contact an external model.

The recorded scenario:

1. opens a real project file and the real Fikeya Chat webview;
2. initializes Fikeya Runtime and Qarinah in that disposable project;
3. configures the bundled runtime with the credential-free loopback profile, completes a real three-call Chat turn, and verifies the visible assistant response plus provider-reported usage;
4. creates a three-step durable plan through the Plan form;
5. reviews the immutable plan;
6. starts it to the first exact approval boundary;
7. issues one expiring, single-use approval for each selected step; and
8. executes and verifies three read-only workspace operations before asserting the final succeeded receipt chain.

No provider credential is needed. The deterministic server binds only to `127.0.0.1`, and the runtime profile and usage database live under the disposable `FIKEYA_HOME`. The Plan proof grants authority only to `workspace.list_files`, `workspace.read_file`, and `workspace.search_text` inside the disposable project. It never writes a project file, invokes a shell, or authorizes network access. The scenario verifies the successful assistant response and exact `60` input, `12` cached-input, and `15` output tokens, then verifies that every Plan step retains a consumed approval, result hash, execution hash, verification hash, and passing check.

## Run

Build the desktop checkout once if `.build/electron` and `out/main.js` do not exist:

```text
npm run electron
npm run transpile-client
```

Then capture the proof:

```text
node scripts/fikeya/capture-desktop-proof.ts
```

The helper compiles the current extension and scenario harness, launches the real app, and writes stable copies to `.build/fikeya-desktop-proof/`:

- `fikeya-chat-real.png`
- `fikeya-plan-draft-real.png`
- `fikeya-plan-reviewed-real.png`
- `fikeya-plan-awaiting-approval-real.png`
- `fikeya-plan-exact-approval-real.png`
- `fikeya-plan-executed-verified-real.png`
- `fikeya-plan-succeeded-real.png`
- `fikeya-plan-lifecycle-proof.json`
- `fikeya-desktop-proof.json`

The JSON manifest points to the original evidence directory, HTML report, captioned video when FFmpeg is available, Playwright trace, exact app version, platform, SHA-256 of every copied screenshot, and the validated content-free Plan receipt. The lifecycle receipt records the final plan, record, tool-call, result, execution, and verification digests without copying tool output. The original scenario bundle remains under `.build/vscode-playwright-mcp/evidence/`.

Use `--check` for a fast prerequisite check, `--output <dir>` to choose the stable-copy directory, or `--skip-compile` only when the extension and scenario runner were already compiled from the current sources.

The deterministic proof intentionally uses the explicit Plan JSON path after the completed Chat turn. The local provider proves that Desktop sends requests through the bundled runtime and renders a genuine provider response and measured receipt without pretending to benchmark a production model. The Plan screenshots separately prove the durable local state machine and stop before any tool is approved or executed.
